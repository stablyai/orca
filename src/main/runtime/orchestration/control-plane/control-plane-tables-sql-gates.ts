/** The gate, lease, intake and liveness half of the control-plane schema.
 *
 *  Split purely by size from `control-plane-tables-sql.ts`; both halves are
 *  concatenated and executed together, and every statement stays
 *  `CREATE TABLE IF NOT EXISTS` so opening an older database is still additive.
 */
export function createControlPlaneGateTablesSql(): string {
  return `
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

-- Final closure B1/B3: one immutable gate definition per outcome. The
-- coordinator/DCS manifest freezes this before worker launch; gate-run looks it
-- up by id and never executes a caller-substituted command.
CREATE TABLE IF NOT EXISTS control_plane_required_gate_specs (
  outcome_id       TEXT NOT NULL,
  gate_id          TEXT NOT NULL,
  program          TEXT NOT NULL,
  args_json        TEXT NOT NULL DEFAULT '[]',
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  policy_version   TEXT NOT NULL,
  command_identity TEXT NOT NULL,
  sha_binding      TEXT NOT NULL CHECK(sha_binding IN ('content', 'exact_head')),
  spec_hash        TEXT NOT NULL,
  PRIMARY KEY (outcome_id, gate_id)
);

-- Additive authority binding for historical-db compatibility. A successful
-- process row without this exact Dispatch/worktree/build/spec record cannot
-- satisfy an outcome completion.
CREATE TABLE IF NOT EXISTS control_plane_gate_execution_authority (
  execution_id     TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  outcome_id       TEXT NOT NULL,
  dispatch_id      TEXT NOT NULL,
  worktree_id      TEXT NOT NULL,
  build_id         TEXT NOT NULL,
  policy_version   TEXT NOT NULL,
  command_identity TEXT NOT NULL,
  spec_hash        TEXT NOT NULL,
  input_hashes     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_control_plane_gate_execution_authority_scope
  ON control_plane_gate_execution_authority(run_id, outcome_id, dispatch_id);

CREATE TABLE IF NOT EXISTS control_plane_intake_batches (
  batch_id             TEXT PRIMARY KEY,
  manifest_fingerprint TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The complete normalized manifest, not only an opaque caller fingerprint.
-- Kept additive so an older intake row remains readable but cannot be mistaken
-- for a schema-v1 replay whose semantics were never persisted.
CREATE TABLE IF NOT EXISTS control_plane_intake_manifests (
  batch_id       TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  manifest_json  TEXT NOT NULL
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

-- The phase row deliberately stays compact and backwards compatible.  A
-- separate claim row carries the runtime incarnation and deadline that make a
-- persisted starting state recoverable after process death.  The claim is
-- created in the same IMMEDIATE transaction as the pending -> starting update
-- and is deleted on every resolved transition.
CREATE TABLE IF NOT EXISTS control_plane_phase_start_claims (
  phase_id        TEXT PRIMARY KEY,
  owner_epoch     TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  claimed_at      TEXT NOT NULL,
  deadline_at     TEXT NOT NULL,
  FOREIGN KEY (phase_id) REFERENCES control_plane_phase_launches(phase_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_control_plane_phase_start_claims_deadline
  ON control_plane_phase_start_claims(deadline_at);

-- An accepted completion is terminal even if planning its next phase throws.
-- Persist the exact replay input and one typed wake receipt so the runtime can
-- reconcile the transition instead of logging and silently stranding it.
CREATE TABLE IF NOT EXISTS control_plane_lifecycle_advance_failures (
  source_dispatch_id TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  task_id             TEXT NOT NULL,
  outcome_id          TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  final_sha           TEXT NOT NULL,
  outcome_of_report   TEXT NOT NULL CHECK(outcome_of_report IN ('succeeded', 'failed')),
  error               TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'retryable'
    CHECK(state IN ('retryable', 'resolved')),
  attempts            INTEGER NOT NULL DEFAULT 1,
  blocker_message_id  TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_control_plane_lifecycle_advance_failures_run
  ON control_plane_lifecycle_advance_failures(run_id, state, created_at);

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

CREATE TABLE IF NOT EXISTS control_plane_validation_lease_authority (
  scope_key          TEXT NOT NULL,
  lease_id           TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  outcome_id         TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  dispatch_id        TEXT NOT NULL,
  worktree_id        TEXT NOT NULL,
  owner_handle       TEXT NOT NULL,
  owner_pane_key     TEXT NOT NULL,
  process_incarnation TEXT NOT NULL,
  launch_token_hash  TEXT NOT NULL,
  runtime_id         TEXT NOT NULL,
  build_id           TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  PRIMARY KEY (scope_key, lease_id)
);

CREATE INDEX IF NOT EXISTS idx_control_plane_validation_leases_idem
  ON control_plane_validation_leases(idempotency_key);
`
}
