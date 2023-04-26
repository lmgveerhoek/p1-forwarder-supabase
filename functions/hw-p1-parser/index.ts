// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Thanks to jvandenaardweg for the telegram parser
// https://github.com/jvandenaardweg/homewizard-energy-api
import { ParsedTelegram, parseTelegram } from "./utils/telegram.ts";
import * as log from "https://deno.land/std@0.181.0/log/mod.ts";
import { DateTime } from "https://esm.sh/luxon@3";


serve(async (req) => {
  // Get text from request body and parse it to a telegram object
  const text = await req.text();
  const telegram: ParsedTelegram = parseTelegram(text);

  // Convert the telegram timestamp to UTC
  telegram.timestamp = convertToUTC(
    telegram.timestamp,
    "Europe/Amsterdam"
  );

  // Convert the telegram gas timestamp to UTC
  telegram.gas.timestamp = convertToUTC(
    telegram.gas.timestamp,
    "Europe/Amsterdam"
  );

  // Construct the data for the telegrams table
  const rowEntry = {
    power_timestamp: telegram.timestamp,
    power_t1: telegram.power.import.t1.value,
    power_t2: telegram.power.import.t2.value,
    power_total:
      telegram.power.import.t1.value + telegram.power.import.t2.value,
    power_active: telegram.power.import.active.value,
    gas_timestamp: telegram.gas.timestamp,
    gas_value: telegram.gas.value,
  };

  // Construct the data for the power table
  const powerData = {
    power_timestamp: telegram.timestamp,
    power_t1: telegram.power.import.t1.value,
    power_t2: telegram.power.import.t2.value,
    power_total:
      telegram.power.import.t1.value + telegram.power.import.t2.value,
    power_active: telegram.power.import.active.value,
  };

  // Construct the data for the gas table
  const gasData = {
    gas_timestamp: telegram.gas.timestamp,
    gas_value: telegram.gas.value,
  };


  try {
    // Create a Supabase client with the Auth context of the logged in user.
    const supabaseClient = createClient(
      // Supabase API URL - env var exported by default.
      Deno.env.get("SUPABASE_URL") ?? "",
      // Supabase API ANON KEY - env var exported by default.
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      // Create client with Auth context of the user that called the function.
      // This way your row-level-security (RLS) policies are applied.
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization")! },
        },
      }
    );

    // Now we can get the session or user object
    const {
      data: { user },
    } = await supabaseClient.auth.getUser();

    // Post the parsed telegram to the database
    const { data: telegramData, error: telegramError } = await supabaseClient
      .from("telegrams")
      .insert(rowEntry);
    if (telegramError) throw telegramError;

    // Check if timestamp of power data is devisable by 5
    // To prevent huge amounts of data in the database
    const date = new Date(powerData.power_timestamp);
    const isDivasable = date.getMinutes() % 5 === 0;

    // Post the power data to the database if it is not already available in the database
    // and if the timestamp is devisable by 5
    if (isDivasable) {
      const { data: powerDataData, error: powerDataError } =
        await supabaseClient.from("usage_power").insert(powerData);
      if (powerDataError) throw powerDataError;
    }

    // First check if the gas data is already available in the database
    const { data: gasDataExists, error: gasDataExistsError } =
      await supabaseClient
        .from("usage_gas")
        .select("gas_timestamp")
        .eq("gas_timestamp", gasData.gas_timestamp);
    if (gasDataExistsError) throw gasDataExistsError;

    // Log the gas data exists
    log.info(gasDataExists ? "Gas data exists" : "Gas data does not exist")

    // If the gas data is not available in the database, post it
    if (gasDataExists.length === 0) {
      const { data: gasDataData, error: gasDataError } = await supabaseClient
        .from("usage_gas")
        .insert(gasData);
      if (gasDataError) throw gasDataError;
    }

    return new Response(JSON.stringify({ user, parsedRow: rowEntry }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    log.error(error.message);
    return new Response(
      JSON.stringify({ error: error.message, parsedRow: rowEntry }),
      {
        headers: { "Content-Type": "application/json" },
        status: 400,
      }
    );
  }
});

function convertToUTC(timestamp, timezone) {
  const date = DateTime.fromISO(timestamp).setZone(timezone, {
    keepLocalTime: true,
  });

  // Get the UTC timestamp by calling toUTC()
  const utcDateTime = date.toUTC();

  // Print the UTC timestamp of the gasdata
  log.info(`Timestamp: ${utcDateTime.toISO()}`);

  // Convert the UTC timestamp to a string and return
  return utcDateTime.toISO();
}

// To invoke:
// curl -i --location --request POST 'http://localhost:54321/functions/v1/' \
//   --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
//   --header 'Content-Type: application/json' \
//   --data '{"name":"Functions"}'
