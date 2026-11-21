// Expose an already-running collector; never preload a module or require elevated runtime privileges.
export const POSTGRES_STATEMENT_STATS_MIGRATION = `
DO $relay_statement_stats$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_settings
    WHERE name = 'shared_preload_libraries'
      AND 'pg_stat_statements' = ANY(string_to_array(replace(setting, ' ', ''), ','))
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_stat_statements'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name = 'pg_stat_statements'
  ) THEN
    RETURN;
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtext('orca-relay'), hashtext('statement-stats')) THEN
    RETURN;
  END IF;

  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE WARNING 'orca_relay_statement_stats_unavailable: insufficient privilege';
  END;
END
$relay_statement_stats$;
`
