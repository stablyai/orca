// Why additive-only: every table here is created with IF NOT EXISTS from the
// same constructor path that builds the legacy tables, so an existing
// orchestration database gains them without a user_version bump and without
// any historical row being rewritten. Nothing in the pre-B reader path selects
// from these tables, so an older Orca binary opening the same file keeps
// working; a newer binary opening an older file simply sees empty tables and
// fails closed on the criteria that require a row.
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
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_dispatch_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_certification_intents_run
  ON control_plane_certification_intents(run_id);

CREATE TABLE IF NOT EXISTS control_plane_gate_executions (
  execution_id  TEXT PRIMARY KEY,
  scope_key     TEXT NOT NULL,
  gate_id       TEXT NOT NULL,
  final_sha     TEXT NOT NULL,
  command       TEXT NOT NULL,
  exit_code     INTEGER,
  log_digest    TEXT NOT NULL,
  build_id      TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_plane_gate_executions_lookup
  ON control_plane_gate_executions(scope_key, gate_id, final_sha);

CREATE TABLE IF NOT EXISTS control_plane_intake_batches (
  batch_id             TEXT PRIMARY KEY,
  manifest_fingerprint TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS control_plane_outcome_relations (
  left_outcome_id  TEXT NOT NULL,
  right_outcome_id TEXT NOT NULL,
  kind             TEXT NOT NULL
    CHECK(kind IN ('semantic_overlap', 'resource_collision')),
  decision         TEXT NOT NULL
    CHECK(decision IN ('independent', 'serialize', 'merge')),
  rationale        TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (left_outcome_id, right_outcome_id, kind)
);

-- B7 (correction 2): the routing policy for one outcome. Separate from the
-- outcome row so a database created by an earlier build gains it additively.
-- Candidate ORDER is supplied by the classifying layer; the control plane never
-- invents one, which is what keeps model choice out of this code.
CREATE TABLE IF NOT EXISTS control_plane_outcome_policy (
  outcome_id          TEXT PRIMARY KEY,
  task_classification TEXT NOT NULL DEFAULT 'bounded_implementation',
  builder_candidates  TEXT NOT NULL DEFAULT '[]',
  reviewer_candidates TEXT NOT NULL DEFAULT '[]',
  review_capabilities TEXT NOT NULL DEFAULT '[]',
  allow_unknown_quota INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- B7 (correction 2): every phase the lifecycle created for an outcome, so a
-- replayed completion is idempotent and recovery can see the exact chain.
CREATE TABLE IF NOT EXISTS control_plane_outcome_phases (
  phase_id        TEXT PRIMARY KEY,
  outcome_id      TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK(kind IN ('build', 'review', 'fix_first')),
  task_id         TEXT NOT NULL,
  source_task_id  TEXT,
  source_dispatch_id TEXT,
  bound_sha       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'planned'
    CHECK(status IN ('planned', 'settled')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_control_plane_outcome_phases_outcome
  ON control_plane_outcome_phases(outcome_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_plane_outcome_phases_source
  ON control_plane_outcome_phases(source_dispatch_id, kind)
  WHERE source_dispatch_id IS NOT NULL;

-- B7 (correction 3): the durable launch record for one planned phase. Separate
-- table so a database created by correction 2 gains it additively.
-- One row per phase is the idempotency key: the driver can crash, retry, or run
-- twice and still reach exactly one Dispatch. dispatch_id is filled from the
-- worker-start receipt, or recovered from the durable mutation receipt when the
-- response was lost.
CREATE TABLE IF NOT EXISTS control_plane_phase_launches (
  phase_id        TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  outcome_id      TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK(kind IN ('review', 'fix_first')),
  state           TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending', 'starting', 'started', 'start_unknown', 'blocked', 'failed')),
  agent           TEXT,
  model           TEXT,
  reasoning       TEXT,
  -- Set only for a retained re-engagement; null means a fresh session.
  terminal_handle TEXT,
  -- The worktree the reviewed commit lives in, so a fresh reviewer lands on the
  -- same tree rather than wherever the coordinator happens to sit.
  worktree_id     TEXT,
  bound_sha       TEXT NOT NULL,
  dispatch_id     TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_control_plane_phase_launches_run
  ON control_plane_phase_launches(run_id, state);
-- A Task can back at most one launch, so a replay can never fork a second one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_plane_phase_launches_task
  ON control_plane_phase_launches(task_id);

-- B4: runtime-owned liveness marker. Writer: the runtime liveness sweep.
-- Consumer: the wake planner and the B10 state query. Never written by a model.
CREATE TABLE IF NOT EXISTS control_plane_dispatch_liveness (
  dispatch_id  TEXT PRIMARY KEY,
  verdict      TEXT NOT NULL
    CHECK(verdict IN ('live', 'unverifiable', 'exited')),
  activity     TEXT NOT NULL
    CHECK(activity IN ('working', 'blocked_on_approved_wait', 'stalled', 'crashed', 'settled')),
  reason       TEXT NOT NULL DEFAULT '',
  observed_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  epoch        TEXT,
  woke_for     TEXT,
  terminal     INTEGER NOT NULL DEFAULT 0
);

-- B8: gate receipts bind deterministic inputs so an unaffected gate can be reused.
CREATE TABLE IF NOT EXISTS control_plane_gate_receipts (
  receipt_id       TEXT PRIMARY KEY,
  scope_key        TEXT NOT NULL,
  gate_id          TEXT NOT NULL,
  final_sha        TEXT NOT NULL,
  input_hashes     TEXT NOT NULL DEFAULT '{}',
  policy_version   TEXT NOT NULL,
  command_identity TEXT NOT NULL,
  result           TEXT NOT NULL CHECK(result IN ('PASS', 'FAIL')),
  recorded_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_control_plane_gate_receipts_scope
  ON control_plane_gate_receipts(scope_key, gate_id, recorded_at);

-- B9: runtime-owned validation lease. One active lease per scope key.
CREATE TABLE IF NOT EXISTS control_plane_validation_leases (
  scope_key       TEXT PRIMARY KEY,
  lease_id        TEXT NOT NULL,
  owner           TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  acquired_at     TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  released_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_control_plane_validation_leases_idem
  ON control_plane_validation_leases(idempotency_key);
`
}
