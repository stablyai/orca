// Why additive-only: every table here is created with IF NOT EXISTS from the
// same constructor path that builds the legacy tables, so an existing
// orchestration database gains them without a user_version bump and without
// any historical row being rewritten. Nothing in the pre-B reader path selects
// from these tables, so an older Orca binary opening the same file keeps
// working; a newer binary opening an older file simply sees empty tables and
// fails closed on the criteria that require a row.
import { createControlPlaneGateTablesSql } from './control-plane-tables-sql-gates'

/** Both halves are executed together as one additive schema. The split is by
 *  size only, so the gate/lease/intake tables must be concatenated here — an
 *  exported-but-unused second half is a schema that silently does not exist. */
export function createControlPlaneTablesSql(): string {
  return `
-- B1 + CORRECTION 1: the authoritative route registry. Declared eligibility
-- and discovered runtime truth only; certification never lives here.
-- Writer: the registry publisher. Consumer: admitRoute / selectRoute.
CREATE TABLE IF NOT EXISTS control_plane_routes (
  route_key            TEXT PRIMARY KEY,
  agent                TEXT NOT NULL,
  model                TEXT,
  reasoning            TEXT,
  provider             TEXT NOT NULL DEFAULT 'UNKNOWN',
  harness              TEXT NOT NULL DEFAULT 'UNKNOWN',
  roles                TEXT NOT NULL DEFAULT '[]',
  task_capabilities    TEXT NOT NULL DEFAULT '[]',
  session_modes        TEXT NOT NULL DEFAULT '[]',
  reasoning_modes      TEXT NOT NULL DEFAULT '[]',
  context_limit_tokens TEXT NOT NULL DEFAULT 'UNKNOWN',
  cost_class           TEXT NOT NULL DEFAULT 'UNKNOWN',
  identity_proof       TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK(identity_proof IN ('exact', 'alias', 'UNKNOWN')),
  launcher_supported   INTEGER NOT NULL DEFAULT 0,
  hook_supported       INTEGER NOT NULL DEFAULT 0,
  readiness            TEXT NOT NULL DEFAULT '{}',
  constraints_json     TEXT NOT NULL DEFAULT '[]',
  notes                TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- B1 + CORRECTION 1: durable certification evidence. Certification state is
-- always derived from these rows, so nothing can assert PASS without evidence.
-- Idempotency: one newest row per (route, role, session mode, kind, sha).
CREATE TABLE IF NOT EXISTS control_plane_route_evidence (
  route_key       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK(role IN ('builder', 'reviewer')),
  session_mode    TEXT NOT NULL CHECK(session_mode IN ('fresh', 'retained')),
  outcome         TEXT NOT NULL CHECK(outcome IN ('PASS', 'FAIL', 'UNSUPPORTED')),
  observed_at     TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  commit_sha      TEXT NOT NULL,
  detail          TEXT,
  PRIMARY KEY (route_key, kind, role, session_mode, commit_sha, runtime_version)
);

CREATE INDEX IF NOT EXISTS idx_control_plane_route_evidence_route
  ON control_plane_route_evidence(route_key, role, session_mode, observed_at);

-- CORRECTION 1: scrubbed SCL model-performance ledger. Enumerated and numeric
-- columns only, by design: there is no column a customer artefact or PII could
-- be written into. Provenance is explicit; prompt claims are not an admissible
-- source. Retention is enforced by pruneModelPerformanceLedger.
CREATE TABLE IF NOT EXISTS control_plane_model_performance (
  entry_id                  TEXT PRIMARY KEY,
  recorded_at               TEXT NOT NULL,
  route_key                 TEXT NOT NULL,
  agent                     TEXT NOT NULL,
  model                     TEXT,
  model_version             TEXT NOT NULL DEFAULT 'UNKNOWN',
  role                      TEXT NOT NULL CHECK(role IN ('builder', 'reviewer')),
  task_classification       TEXT NOT NULL,
  first_pass_result         TEXT NOT NULL
    CHECK(first_pass_result IN ('accepted', 'corrections_required', 'failed', 'UNKNOWN')),
  correction_rounds         INTEGER NOT NULL DEFAULT 0,
  reviewer_defects          INTEGER NOT NULL DEFAULT 0,
  escaped_defects           INTEGER NOT NULL DEFAULT 0,
  wall_clock_ms             INTEGER,
  tool_calls                INTEGER,
  context_tokens_used       INTEGER,
  provider_limit_interrupted INTEGER NOT NULL DEFAULT 0,
  rescue_route_key          TEXT,
  provenance                TEXT NOT NULL
    CHECK(provenance IN ('observed_runtime', 'imported_evidence'))
);

CREATE INDEX IF NOT EXISTS idx_control_plane_model_performance_route
  ON control_plane_model_performance(route_key, recorded_at);

-- B2: one outcome, one durable Run.
CREATE TABLE IF NOT EXISTS control_plane_outcomes (
  outcome_id     TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL DEFAULT '',
  fingerprint    TEXT NOT NULL,
  intake_batch   TEXT,
  status         TEXT NOT NULL DEFAULT 'admitted'
    CHECK(status IN ('admitted', 'closed')),
  gate_policy    TEXT NOT NULL DEFAULT 'standard'
    CHECK(gate_policy IN ('standard', 'high_risk')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_control_plane_outcomes_batch
  ON control_plane_outcomes(intake_batch);

-- B2: explicit representation of semantic overlap / resource collision between
-- two outcomes admitted in the same intake batch. An undecided pair is refused.
-- Correction: binds a batch id to the manifest it was admitted with, so a
-- replay carrying different outcomes is a conflict rather than an enlargement.
-- Blocker 1: a gate result is only evidence when the RUNTIME ran the process.
-- A caller-declared PASS has no row here, and the completion gate refuses it.
CREATE TABLE IF NOT EXISTS control_plane_pretool_receipts (
  receipt_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  tool_name TEXT,
  reason TEXT,
  build_id TEXT NOT NULL,
  run_id TEXT,
  outcome_id TEXT,
  task_id TEXT,
  terminal_handle TEXT,
  pane_key TEXT,
  process_incarnation TEXT,
  requested_route TEXT,
  effective_route TEXT,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pretool_receipts_dispatch
  ON control_plane_pretool_receipts(dispatch_id);

CREATE TABLE IF NOT EXISTS control_plane_route_runtime_events (
  dispatch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  decision TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (dispatch_id, kind)
);

CREATE TABLE IF NOT EXISTS control_plane_certification_intents (
  intent_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  reasoning TEXT,
  build_id TEXT NOT NULL,
  retry_of TEXT,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_dispatch_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_certification_intents_run
  ON control_plane_certification_intents(run_id);
${createControlPlaneGateTablesSql()}`
}
