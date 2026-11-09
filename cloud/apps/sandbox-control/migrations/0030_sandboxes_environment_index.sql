-- The warm pool asks "was this environment used lately?" on every create and cron tick.
CREATE INDEX IF NOT EXISTS sandboxes_environment_created ON sandboxes (environment_id, created_at);
