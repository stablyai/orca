-- U22: each session's measured CPU, for internal fair-use review only. Customers keep flat
-- sandbox hours: nothing here feeds usage_outbox, billing or any customer-facing route.
-- One row per provider session (idempotent); active_cpu_ms stays NULL until Vercel reports it
-- after the VM stops, and a cron sweep retries the ones still missing. Additive.
CREATE TABLE session_cpu (
  session_id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  user_id TEXT,
  vcpus INTEGER NOT NULL,
  memory_mb INTEGER,
  active_cpu_ms INTEGER,
  wall_ms INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER NOT NULL,
  fetched_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX session_cpu_account_ended ON session_cpu (account_id, ended_at);
CREATE INDEX session_cpu_pending ON session_cpu (ended_at) WHERE active_cpu_ms IS NULL;
