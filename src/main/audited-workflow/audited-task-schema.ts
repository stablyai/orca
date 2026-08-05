// Schema DDL and migration for the audited-workflow SQLite database. Kept
// separate from the repository class so schema evolution reviews as its own
// unit — see plan §6 for the full multi-phase schema; Phase 1 creates only
// audited_tasks and audited_transitions.
import { LAND_ATTEMPT_STATUSES } from '../../shared/audited-landing-types'
import {
  AUDITED_TASK_STATES,
  COMMIT_ATTEMPT_STATUSES,
  PUBLISH_ATTEMPT_STATUSES,
  TASK_SOURCES,
  RISK_LEVELS,
  TASK_ACTORS,
  TRIAGE_DECISIONS,
  TRIAGE_RUN_STATUSES,
  TRIAGE_REASON_CODES
} from '../../shared/audited-workflow-types'
import {
  WORKTREE_ATTEMPT_STATUSES,
  WORKTREE_PROVENANCE_KINDS,
  WORKTREE_REASON_CODES
} from '../../shared/audited-worktree-types'
import { REVIEW_VERDICTS } from '../../shared/audited-workflow-types'
// Per-phase DDL lives in its own module so this file stays within its line
// budget and each phase's schema reviews as its own unit.
import { createExecutionRunsTable } from './audited-execution-schema'
import { PHASE_5_TASK_COLUMNS, createPlanReviewTables } from './audited-plan-review-schema'
import { createPlanCoverageTable } from './audited-plan-coverage-schema'
import {
  PHASE_7_TASK_COLUMNS,
  createCodeAuditTables,
  rebuildExecutionRunsForFixMode
} from './audited-code-audit-schema'
import {
  PHASE_8_CANDIDATE_COLUMNS,
  PHASE_8_TASK_COLUMNS,
  createCommitTables
} from './audited-commit-schema'
import { createPublishTables, migrateToV9 } from './audited-publish-schema'
import { createLandTables, migrateToV10 } from './audited-land-schema'
import { migrateToV11 } from './audited-no-tools-schema'
import type Database from '../sqlite/sync-database'

// Schema versions: v1 initial (audited_tasks, audited_transitions). v2 (Phase 2)
// adds audited_triage_runs plus triage status columns on audited_tasks. v3
// (Phase 3) adds audited_worktree_attempts plus worktree identity/provenance
// columns. v4 (Phase 4) adds audited_execution_runs — ALSO FULLY ADDITIVE:
// Phase 4 introduces no new task state (its one new transition rule,
// cancelImplementation, is TypeScript in audited-workflow-state-machine.ts and
// the database has no notion of transition legality), so audited_tasks' state
// CHECK is unchanged and no table rebuild is needed. audited_transitions.event_type
// is unconstrained TEXT, so the new execution_* event types need no migration.
// v5 (Phase 5) adds audited_plan_artifacts + audited_plan_review_runs plus two
// audited_tasks columns (current_plan_artifact_id, last_verdict) — ALSO FULLY
// ADDITIVE. Phase 5 introduces no new task state (its only state-machine change
// retargets the EXISTING `revisePlan` rule, which is TypeScript, not schema), so
// audited_tasks' state CHECK is unchanged. Artifact-file write failures reuse the
// EXISTING `spawn_failed` execution reason rather than adding a code, so
// audited_execution_runs' CHECK is untouched and v5 needs no table rebuild.
// v6 (Phase 6) adds audited_plan_coverage — ALSO FULLY ADDITIVE, and the most
// additive yet: it adds NO audited_tasks column at all. Current coverage is
// DERIVED from the latest succeeded plan-review run still bound to the task's
// current artifact, so unlike current_plan_artifact_id there is no denormalized
// pointer that could disagree with the rows. Phase 6 introduces no task state, no
// state-machine command, and no new PLAN_REVIEW_REASON_CODES member, so the state
// CHECK and audited_plan_review_runs' reason_code CHECK are both unchanged. It
// also adds no transition event type: coverage rides in the EXISTING finalization
// transition's previously-unused detail_json as a {covered,total} count.
// v7 (Phase 7) adds audited_candidates + audited_code_audit_runs plus two
// audited_tasks columns (current_candidate_id, code_audit_verdict) — and is the
// FIRST version that is NOT purely additive. A Phase 7 `fix` run lives in
// code_fixes_requested -> awaiting_code_audit, which audited_execution_runs'
// pre_launch_state / active_run_state CHECKs exclude; SQLite cannot ALTER a
// CHECK, so v7 rebuilds THAT ONE TABLE (see rebuildExecutionRunsForFixMode).
// audited_tasks' state CHECK is still unchanged — Phase 7 introduces no task
// state, only writers for states declared since Phase 1.
// v8 (Phase 8) adds audited_approvals + audited_commit_attempts +
// audited_store_reservations, two audited_tasks columns (current_approval_id,
// commit_attempt_status), and two audited_candidates columns (store_bytes,
// store_expires_at_ms) — FULLY ADDITIVE, unlike v7. Phase 8 introduces no task
// state: awaiting_human_approval, committing, and committed have all been
// declared since Phase 1, so audited_tasks' state CHECK is unchanged and NO
// table rebuild is required. audited_transitions.event_type is unconstrained
// TEXT, so the new commit_* event types need no migration either.
// v9 (Phase 9) adds audited_publish_attempts plus four audited_tasks columns
// (publish_attempt_status, published_sha, review_provider, review_number) —
// FULLY ADDITIVE, like v8. Phase 9 introduces NO task state: a task stays in
// `committed` for the whole publish lane, precisely so a failed or ambiguous push
// can never make the local commit look undone. audited_tasks' state CHECK is
// therefore unchanged and no table rebuild is required, and the landing/landed
// states plus landed_sha stay unwritten for a future local-integration phase.
// v10 (Phase 10) adds audited_land_attempts plus two audited_tasks columns
// (land_attempt_status, landing_advisory) — FULLY ADDITIVE, like v8 and v9. This
// is the phase that finally WRITES the landing/landed states and the
// landed_sha / landed_base_sha / landing_reason_code columns reserved since
// Phase 1, but it introduces no NEW state: both have been in audited_tasks' state
// CHECK from the beginning, so that CHECK is unchanged and no table rebuild is
// required. audited_transitions.event_type is unconstrained TEXT, so the new
// land_* event types need no migration either.
// v11 adds `audit_mode` to both run tables — additive, no rebuild. NULL reads as
// `codex_cli`; see audited-no-tools-schema.ts for why that default direction.
export const SCHEMA_VERSION = 11

export function createAuditedWorkflowTables(db: Database.Database): void {
  const stateList = AUDITED_TASK_STATES.map((s) => `'${s}'`).join(', ')
  const sourceList = TASK_SOURCES.map((s) => `'${s}'`).join(', ')
  const riskList = RISK_LEVELS.map((r) => `'${r}'`).join(', ')
  const actorList = TASK_ACTORS.map((a) => `'${a}'`).join(', ')
  const triageDecisionList = TRIAGE_DECISIONS.map((d) => `'${d}'`).join(', ')
  const triageRunStatusList = TRIAGE_RUN_STATUSES.map((s) => `'${s}'`).join(', ')
  const triageReasonList = TRIAGE_REASON_CODES.map((r) => `'${r}'`).join(', ')
  const attemptStatusList = WORKTREE_ATTEMPT_STATUSES.map((s) => `'${s}'`).join(', ')
  const provenanceList = WORKTREE_PROVENANCE_KINDS.map((p) => `'${p}'`).join(', ')
  const worktreeReasonList = WORKTREE_REASON_CODES.map((r) => `'${r}'`).join(', ')
  const verdictList = REVIEW_VERDICTS.map((v) => `'${v}'`).join(', ')
  const commitAttemptStatusList = COMMIT_ATTEMPT_STATUSES.map((s) => `'${s}'`).join(', ')
  const publishAttemptStatusList = PUBLISH_ATTEMPT_STATUSES.map((s) => `'${s}'`).join(', ')

  db.exec(`
    CREATE TABLE IF NOT EXISTS audited_tasks (
      id                          TEXT PRIMARY KEY,
      repo_id                     TEXT NOT NULL,
      source_repo_path            TEXT NOT NULL,
      worktree_id                 TEXT,
      worktree_path               TEXT,
      branch_name                 TEXT,
      base_commit                 TEXT NOT NULL,
      host_id                     TEXT NOT NULL DEFAULT 'local',
      wsl_distro                  TEXT,
      title                       TEXT NOT NULL,
      spec_json                   TEXT NOT NULL,
      source                      TEXT NOT NULL CHECK(source IN (${sourceList})),
      roadmap_entry_id            TEXT,
      risk                        TEXT NOT NULL CHECK(risk IN (${riskList})),
      state                       TEXT NOT NULL CHECK(state IN (${stateList})),
      pre_block_state             TEXT,
      blocked_reason_code         TEXT,
      blocked_phase                TEXT,
      active_phase                TEXT,
      active_lock_binding         TEXT,
      plan_round                  INTEGER NOT NULL DEFAULT 0 CHECK(plan_round BETWEEN 0 AND 3),
      fix_round                   INTEGER NOT NULL DEFAULT 0 CHECK(fix_round BETWEEN 0 AND 3),
      audit_approved_tree_oid     TEXT,
      committed_sha               TEXT,
      landed_sha                  TEXT,
      landed_base_sha             TEXT,
      landing_reason_code         TEXT,
      triage_decision             TEXT CHECK(triage_decision IS NULL OR triage_decision IN (${triageDecisionList})),
      triage_run_status           TEXT CHECK(triage_run_status IS NULL OR triage_run_status IN (${triageRunStatusList})),
      triage_blocked_reason_code  TEXT CHECK(triage_blocked_reason_code IS NULL OR triage_blocked_reason_code IN (${triageReasonList})),
      -- Phase 3. worktree_provenance is NULL until a worktree is actually
      -- verified: it describes a real worktree, never migration history.
      worktree_provenance         TEXT CHECK(worktree_provenance IS NULL OR worktree_provenance IN (${provenanceList})),
      worktree_provisioned_at_ms  INTEGER,
      source_repo_common_dir      TEXT,
      worktree_reason_code        TEXT CHECK(worktree_reason_code IS NULL OR worktree_reason_code IN (${worktreeReasonList})),
      worktree_verified_at_ms     INTEGER,
      -- Phase 5. Denormalized pointer to the task's single 'current' plan
      -- artifact, written in the SAME transaction as the artifact row so the two
      -- can never disagree; audited_plan_artifacts stays the source of truth.
      current_plan_artifact_id    TEXT,
      -- Phase 5. The column behind the long-declared lastVerdict projection
      -- field, which audited-task-service.ts hardcoded to null until now. Uses
      -- the EXISTING ReviewVerdict vocabulary — there is no second verdict union.
      last_verdict                TEXT CHECK(last_verdict IS NULL OR last_verdict IN (${verdictList})),
      -- Phase 7. Denormalized pointer to the task's single 'current' candidate,
      -- written in the SAME transaction as the candidate row so the two can never
      -- disagree; audited_candidates stays the source of truth.
      current_candidate_id        TEXT,
      -- Phase 7. The code-audit lane's own verdict, kept separate from
      -- last_verdict (which the plan lane owns) so one lane cannot overwrite the
      -- other's record. Same ReviewVerdict vocabulary.
      code_audit_verdict          TEXT CHECK(code_audit_verdict IS NULL OR code_audit_verdict IN (${verdictList})),
      -- Phase 8. Denormalized pointer to the task's single 'pending' approval,
      -- written in the SAME transaction as the approval row so the two can never
      -- disagree; audited_approvals stays the source of truth.
      current_approval_id         TEXT,
      -- Phase 8. The latest commit attempt's status, projected as-is. The
      -- detailed CommitReasonCode lives on the attempt row, not here.
      commit_attempt_status       TEXT CHECK(commit_attempt_status IS NULL OR commit_attempt_status IN (${commitAttemptStatusList})),
      -- Phase 9. The latest publish attempt's status and the sha proven present
      -- on the remote. The detailed PublishReasonCode and the advisory live on
      -- the attempt row, not here. published_sha is deliberately separate from
      -- landed_sha: publishing to a remote is not landing into the source repo.
      publish_attempt_status      TEXT CHECK(publish_attempt_status IS NULL OR publish_attempt_status IN (${publishAttemptStatusList})),
      published_sha               TEXT,
      review_provider             TEXT,
      review_number               INTEGER,
      -- Phase 10. The latest land attempt's status, projected as-is, and the
      -- advisory recorded on a DURABLE land. The detailed LandingReasonCode lives
      -- in landing_reason_code above (declared since Phase 1); landing_advisory
      -- NEVER holds one, exactly as commit_attempt_status and
      -- post_commit_advisory stay separate.
      land_attempt_status         TEXT CHECK(land_attempt_status IS NULL OR land_attempt_status IN (${LAND_ATTEMPT_STATUSES.map((s) => `'${s}'`).join(', ')})),
      landing_advisory            TEXT,
      created_at_ms                INTEGER NOT NULL,
      updated_at_ms                INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audited_tasks_repo  ON audited_tasks(repo_id);
    CREATE INDEX IF NOT EXISTS idx_audited_tasks_state ON audited_tasks(state);

    CREATE TABLE IF NOT EXISTS audited_transitions (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL,
      from_state  TEXT,
      to_state    TEXT NOT NULL CHECK(to_state IN (${stateList})),
      actor       TEXT NOT NULL CHECK(actor IN (${actorList})),
      event_type  TEXT NOT NULL,
      reason_code TEXT,
      detail_json TEXT,
      at_ms       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audited_transitions_task ON audited_transitions(task_id, seq);

    -- Phase 2: one row per triage invocation. Raw prompt/response text is
    -- never stored here — only the validated structured fields and enough
    -- bookkeeping to reconcile a run that was interrupted mid-flight. The
    -- Claude-ready prompt and rationale are internal artifacts consumed by
    -- later phases in-process; they are never projected to the renderer.
    CREATE TABLE IF NOT EXISTS audited_triage_runs (
      id                TEXT PRIMARY KEY,
      task_id           TEXT NOT NULL,
      status            TEXT NOT NULL CHECK(status IN (${triageRunStatusList})),
      decision          TEXT CHECK(decision IS NULL OR decision IN (${triageDecisionList})),
      reason_code       TEXT CHECK(reason_code IS NULL OR reason_code IN (${triageReasonList})),
      rationale         TEXT,
      acceptance_criteria_json TEXT,
      next_step_prompt  TEXT,
      started_at_ms     INTEGER NOT NULL,
      ended_at_ms       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audited_triage_runs_task ON audited_triage_runs(task_id);
    -- At most one running triage attempt per task, mirroring the
    -- audited_commit_attempts "authorized" partial-unique-index idiom (plan §6) —
    -- this is what makes a duplicate "Start Triage" click a CAS-detectable no-op
    -- rather than a second concurrent provider call.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_triage_runs_running
      ON audited_triage_runs(task_id) WHERE status = 'running';

    -- Phase 3: durable provisioning-attempt evidence. The intended_* columns are
    -- written BEFORE any Git command runs, so a crash between "git worktree add"
    -- and SQLite finalization is recoverable by matching on-disk/Git evidence
    -- against exactly what this row says was intended.
    CREATE TABLE IF NOT EXISTS audited_worktree_attempts (
      id                   TEXT PRIMARY KEY,
      task_id              TEXT NOT NULL,
      status               TEXT NOT NULL CHECK(status IN (${attemptStatusList})),
      intended_branch      TEXT NOT NULL,
      intended_path        TEXT NOT NULL,
      intended_base_commit TEXT NOT NULL,
      intended_common_dir  TEXT NOT NULL,
      provenance_id        TEXT NOT NULL,
      reason_code          TEXT CHECK(reason_code IS NULL OR reason_code IN (${worktreeReasonList})),
      claimed_at_ms        INTEGER NOT NULL,
      created_at_ms        INTEGER,
      finalized_at_ms      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audited_worktree_attempts_task
      ON audited_worktree_attempts(task_id);
    -- At most one live attempt per task: the concurrency primitive that makes a
    -- duplicate Start Triage a CAS-detectable no-op rather than a second worktree.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_worktree_attempts_live
      ON audited_worktree_attempts(task_id) WHERE status IN ('claimed','created','verified');

  `)

  createExecutionRunsTable(db)
  createPlanReviewTables(db)
  createPlanCoverageTable(db)
  createCodeAuditTables(db)
  createCommitTables(db)
  createPublishTables(db)
  createLandTables(db)
}

// Phase 3 columns added to a pre-existing audited_tasks table, with their
// declared affinities.
const PHASE_3_TASK_COLUMNS: readonly [string, string][] = [
  ['worktree_provenance', 'TEXT'],
  ['worktree_provisioned_at_ms', 'INTEGER'],
  ['source_repo_common_dir', 'TEXT'],
  ['worktree_reason_code', 'TEXT'],
  ['worktree_verified_at_ms', 'INTEGER']
]

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((row) => row.name === column)
}

/**
 * Whether audited_execution_runs already carries the widened Phase 7 CHECKs.
 *
 * Read from the stored DDL rather than attempted-insert probing: a probe would
 * have to write and roll back a row, and this runs inside the migration
 * transaction where a rollback would discard the whole migration.
 */
function executionRunsAcceptsFixStates(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audited_execution_runs'`
    )
    .get() as { sql: string } | undefined
  return row?.sql.includes('code_fixes_requested') ?? false
}

// Why: CREATE TABLE IF NOT EXISTS never alters an existing table's columns —
// createAuditedWorkflowTables always runs first (so a brand-new DB gets every
// column directly), then this function additively ALTERs any pre-existing v1
// audited_tasks table that predates the triage columns. Migrate in a
// transaction that bumps user_version only on success, mirroring
// runtime/orchestration/db.ts's atomic all-or-nothing migration.
export function migrateAuditedWorkflowSchema(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current >= SCHEMA_VERSION) {
    return
  }
  db.exec('BEGIN')
  try {
    if (current < 2) {
      if (!columnExists(db, 'audited_tasks', 'triage_decision')) {
        db.exec(`ALTER TABLE audited_tasks ADD COLUMN triage_decision TEXT`)
      }
      if (!columnExists(db, 'audited_tasks', 'triage_run_status')) {
        db.exec(`ALTER TABLE audited_tasks ADD COLUMN triage_run_status TEXT`)
      }
      if (!columnExists(db, 'audited_tasks', 'triage_blocked_reason_code')) {
        db.exec(`ALTER TABLE audited_tasks ADD COLUMN triage_blocked_reason_code TEXT`)
      }
    }
    if (current < 3) {
      // Why additive-only: Phase 3 adds no task state, so audited_tasks' state
      // CHECK constraint is unchanged and no 12-step table rebuild is required.
      // Every Phase 1/Phase 2 row keeps its rowid and column values untouched.
      // ALTER TABLE ADD COLUMN cannot carry a CHECK constraint; the narrowing
      // CHECKs live in createAuditedWorkflowTables for fresh DBs, and every
      // write site uses typed literals from the closed vocabularies.
      for (const [column, type] of PHASE_3_TASK_COLUMNS) {
        if (!columnExists(db, 'audited_tasks', column)) {
          db.exec(`ALTER TABLE audited_tasks ADD COLUMN ${column} ${type}`)
        }
      }
    }
    if (current < 4) {
      // Phase 4 is a pure table addition — no audited_tasks column, no CHECK
      // change, no rebuild. Created here rather than relying on
      // createAuditedWorkflowTables having run: this function is also called
      // directly against a legacy DB (see audited-task-schema.test.ts), and a
      // migration that silently depends on another call having happened first
      // would leave that path without the table.
      createExecutionRunsTable(db)
    }
    if (current < 5) {
      // Phase 5: two new tables plus two additive task columns. No CHECK change
      // on any existing table and no rebuild — artifact write failures reuse the
      // existing `spawn_failed` execution reason precisely so that stays true.
      // Created here rather than relying on createAuditedWorkflowTables having
      // run: this function is also called directly against a legacy DB, and a
      // migration that silently depends on another call would leave that path
      // without the tables.
      for (const [column, type] of PHASE_5_TASK_COLUMNS) {
        if (!columnExists(db, 'audited_tasks', column)) {
          db.exec(`ALTER TABLE audited_tasks ADD COLUMN ${column} ${type}`)
        }
      }
      createPlanReviewTables(db)
    }
    if (current < 6) {
      // Phase 6 is a pure table addition — no task column, no CHECK change, no
      // rebuild. Created here rather than relying on createAuditedWorkflowTables
      // having run, for the same reason as v4/v5: this function is also called
      // directly against a legacy DB, and a migration that silently depends on
      // another call would leave that path without the table.
      createPlanCoverageTable(db)
    }
    if (current < 7) {
      // Phase 7: two new tables plus two additive task columns, AND the one
      // non-additive step in this feature's history — a rebuild of
      // audited_execution_runs to widen its two state CHECKs for `fix` runs.
      // The rebuild runs inside THIS transaction, so a failure anywhere leaves a
      // v6 database completely untouched.
      for (const [column, type] of PHASE_7_TASK_COLUMNS) {
        if (!columnExists(db, 'audited_tasks', column)) {
          db.exec(`ALTER TABLE audited_tasks ADD COLUMN ${column} ${type}`)
        }
      }
      createCodeAuditTables(db)
      // Guarded so a fresh DB (already created with the widened CHECKs) is not
      // rebuilt pointlessly, and so a legacy-DB-direct migration still works.
      if (!executionRunsAcceptsFixStates(db)) {
        rebuildExecutionRunsForFixMode(db)
      }
    }
    if (current < 8) {
      // Phase 8: three new tables plus additive columns on audited_tasks and
      // audited_candidates. FULLY ADDITIVE — no CHECK change on any existing
      // table and no rebuild, because Phase 8 introduces no task state (every
      // state it writes has been declared since Phase 1). Created here rather
      // than relying on createAuditedWorkflowTables having run, for the same
      // reason as v4-v7: this function is also called directly against a legacy
      // DB, and a migration that silently depends on another call would leave
      // that path without the tables.
      for (const [column, type] of PHASE_8_TASK_COLUMNS) {
        if (!columnExists(db, 'audited_tasks', column)) {
          db.exec(`ALTER TABLE audited_tasks ADD COLUMN ${column} ${type}`)
        }
      }
      for (const [column, type] of PHASE_8_CANDIDATE_COLUMNS) {
        if (!columnExists(db, 'audited_candidates', column)) {
          db.exec(`ALTER TABLE audited_candidates ADD COLUMN ${column} ${type}`)
        }
      }
      createCommitTables(db)
    }
    if (current < 9) {
      migrateToV9(db, columnExists)
    }
    if (current < 10) {
      migrateToV10(db, columnExists)
    }
    if (current < 11) {
      migrateToV11(db, columnExists)
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
