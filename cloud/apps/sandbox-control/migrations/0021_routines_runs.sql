-- Routines (W5): additive only, older Workers keep working against this schema.

-- Last four characters of the secret webhook URL, for display ("…a1b2"). The URL itself is never stored.
ALTER TABLE routines ADD COLUMN webhook_hint TEXT;
-- Short, redacted tail of the run's agent/runner log (GET /v1/routines/:id/runs/:runId).
ALTER TABLE routine_runs ADD COLUMN log_tail TEXT;
-- Concurrency caps count active runs per account.
CREATE INDEX routine_runs_account_active ON routine_runs (account_id, status);
