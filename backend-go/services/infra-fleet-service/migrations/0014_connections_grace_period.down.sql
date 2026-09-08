ALTER TABLE infra.connections
  DROP COLUMN IF EXISTS degraded_since,
  DROP COLUMN IF EXISTS grace_period_seconds;
