// What this Orca placed on paired servers that own the workers. New tables only, so an older build
// opens the file and ignores them. Facts in them change only from the server's queue, in its order.
export const REMOTE_OWNED_SCHEMA_SQL = `
-- One per (Run, server) while open; an A reset turns it into a cancel owed and the Run's next start
-- there opens a new one, under a new conversation and so a new peer Run on the server.
CREATE TABLE IF NOT EXISTS remote_run_links (
  conversation_id          TEXT PRIMARY KEY,
  run_id                   TEXT NOT NULL,
  environment_id           TEXT NOT NULL,
  peer_fingerprint         TEXT NOT NULL,
  home_fingerprint         TEXT NOT NULL,
  pairing_revision         INTEGER,
  peer_run_id              TEXT,
  state                    TEXT NOT NULL DEFAULT 'open'
    CHECK(state IN ('open', 'cancel_owed', 'closed')),
  cancel_key               TEXT,
  cancel_attempt           INTEGER NOT NULL DEFAULT 0,
  cancel_retries           INTEGER NOT NULL DEFAULT 0,
  cancel_retry_at          INTEGER,
  last_imported_sequence   INTEGER NOT NULL DEFAULT 0,
  last_error               TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_run_links_open
  ON remote_run_links(run_id, environment_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_remote_run_links_environment
  ON remote_run_links(environment_id, state);

-- A Task being started on, or started on, a server. 'reserved' fences it from every other start
-- until the server answers; the answer's Dispatch is the Task's current attempt there.
CREATE TABLE IF NOT EXISTS remote_placements (
  task_id            TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL,
  environment_id     TEXT NOT NULL,
  conversation_id    TEXT NOT NULL,
  state              TEXT NOT NULL CHECK(state IN ('reserved', 'accepted')),
  request_key        TEXT NOT NULL,
  prior_task_status  TEXT NOT NULL,
  dispatch_id        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What the server last said about one of its Dispatches here, and any stop this Orca owes it.
CREATE TABLE IF NOT EXISTS remote_dispatches (
  dispatch_id        TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  environment_id     TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  worker_state       TEXT,
  last_failure       TEXT,
  agent              TEXT,
  last_report        TEXT,
  stop_owed          INTEGER NOT NULL DEFAULT 0,
  stop_count         INTEGER NOT NULL DEFAULT 0,
  stop_attempt       INTEGER NOT NULL DEFAULT 0,
  stop_retries       INTEGER NOT NULL DEFAULT 0,
  stop_retry_at      INTEGER,
  stop_last_error    TEXT,
  -- This Orca already ran the Task half for the attempt: 1 for a stop the server did not answer,
  -- 2 once it was abandoned here. The first result stands: later states from the server change
  -- only this record. Abandoned here, the attempt is settled for a retry, as a local abandon is.
  task_settled_here  INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  -- When this Orca recorded the server's start answer or, after that, its latest state for the
  -- Dispatch. Reports and this Orca's own stop bookkeeping leave it.
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_remote_dispatches_run ON remote_dispatches(run_id);
CREATE INDEX IF NOT EXISTS idx_remote_dispatches_task ON remote_dispatches(task_id);
CREATE INDEX IF NOT EXISTS idx_remote_dispatches_stop_owed
  ON remote_dispatches(environment_id) WHERE stop_owed = 1;

-- Each distinct stop intent from this Orca and the count it was given, so a retry of an older
-- intent finds its own count instead of minting another.
CREATE TABLE IF NOT EXISTS remote_stop_intents (
  dispatch_id  TEXT NOT NULL,
  intent_key   TEXT NOT NULL,
  stop_count   INTEGER NOT NULL,
  PRIMARY KEY (dispatch_id, intent_key)
);

-- A question a remote worker asked here; its reply goes to the server that owns the question.
CREATE TABLE IF NOT EXISTS remote_owned_questions (
  message_id       TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  environment_id   TEXT NOT NULL,
  dispatch_id      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_remote_owned_questions_run ON remote_owned_questions(run_id);
`
