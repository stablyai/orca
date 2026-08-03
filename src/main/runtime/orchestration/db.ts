/* eslint-disable max-lines -- Why: the orchestration DB keeps schema creation, message CRUD, task DAG resolution, and dispatch context management in one class so transactional invariants (e.g. promoteReadyTasks running inside the same writer as updateTaskStatus) are enforced by locality. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import Database from '../../sqlite/sync-database'
import type {
  MessageType,
  MessagePriority,
  MessageDeliveryContract,
  TaskStatus,
  DispatchStatus,
  GateStatus,
  CoordinatorStatus,
  MessageRow,
  TaskRow,
  DispatchContextRow,
  DecisionGateRow,
  CoordinatorRun,
  WorkerReportOutcome,
  WorkerReportSettlement,
  RunRow,
  DeliveryRow,
  DeliveryStatus,
  LegacyAdoptionRow,
  LegacyCompatibilityPrincipalRow,
  LegacyPrincipalRole,
  LegacyOperationReceiptRow,
  LegacyMailReceiptRow,
  QuestionRow,
  QuestionStatus,
  MutationReceiptRow,
  MutationState,
  WorkerDispatchRow,
  WorkerDispatchState,
  LegacyWorkerTerminalRecoveryRow,
  FederatedDispatchRow,
  RemoteDispatchAttachmentRow,
  FederationRelayDirection,
  FederationRelayItemRow
} from './types'
import { buildOrchestrationTaskDisplayMetadata } from '../../../shared/orchestration-task-display'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../shared/orchestration-rpc-contract'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { OrchestrationError } from './orchestration-error'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'
import {
  deriveWorkerTerminalListState,
  type WorkerTerminalResourceRow,
  type WorkerTerminalArchiveRow,
  type WorkerTerminalArchiveStatus,
  type WorkerTerminalListState,
  type WorkerTerminalOwnershipState,
  type WorkerTerminalRetainedReason
} from './worker-terminal-ownership'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../shared/orchestration-run-pagination'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'

// Why: leaf UUID is the remint-stable pane identity (tab half changes on break-out); exact match covers legacy/unparseable keys.
function isEquivalentPaneKey(a: string, b: string): boolean {
  if (a === b) {
    return true
  }
  const aLeaf = parsePaneKey(a)?.leafId
  const bLeaf = parsePaneKey(b)?.leafId
  return Boolean(aLeaf && bLeaf && aLeaf === bLeaf)
}

// Why: indexable pre-filter for isEquivalentPaneKey — equal strings and equal leaves both share the
// text after the first ':', so this narrows candidates without deciding equivalence itself.
const RUN_PANE_KEY_MATCH_SUFFIX_SQL =
  "substr(coordinator_pane_key, instr(coordinator_pane_key, ':') + 1)"
const DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL =
  "substr(assignee_pane_key, instr(assignee_pane_key, ':') + 1)"

function paneKeyMatchSuffix(paneKey: string): string {
  const colon = paneKey.indexOf(':')
  return colon < 0 ? paneKey : paneKey.slice(colon + 1)
}

export type {
  MessageType,
  MessagePriority,
  MessageDeliveryContract,
  TaskStatus,
  DispatchStatus,
  GateStatus,
  CoordinatorStatus,
  MessageRow,
  TaskRow,
  DispatchContextRow,
  DecisionGateRow,
  CoordinatorRun,
  WorkerReportOutcome,
  WorkerReportSettlement,
  RunRow,
  DeliveryRow,
  DeliveryStatus,
  LegacyAdoptionRow,
  LegacyCompatibilityPrincipalRow,
  LegacyPrincipalRole,
  LegacyOperationReceiptRow,
  LegacyMailReceiptRow,
  QuestionRow,
  QuestionStatus,
  MutationReceiptRow,
  MutationState,
  WorkerDispatchRow,
  WorkerDispatchState
}

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

function hashDispatchCapability(capability: string): string {
  return createHash('sha256').update(capability).digest('hex')
}

function addLifecycleRejectionMarker(payload: string | null, code: string, reason: string): string {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = payload ? JSON.parse(payload) : {}
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>
    }
  } catch {
    // Authority reconciliation only reaches this path with object payloads.
  }
  return JSON.stringify({
    ...parsed,
    _orcaLifecycleRejection: { code, reason }
  })
}

function hasLifecycleRejectionMarker(payload: string | null): boolean {
  try {
    const value: unknown = JSON.parse(payload ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false
    }
    const marker = (value as Record<string, unknown>)._orcaLifecycleRejection
    return Boolean(
      marker &&
      typeof marker === 'object' &&
      !Array.isArray(marker) &&
      typeof (marker as Record<string, unknown>).code === 'string' &&
      typeof (marker as Record<string, unknown>).reason === 'string'
    )
  } catch {
    return false
  }
}

const SQLITE_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

function exposeUtcTimestamp(timestamp: string | null): string | null {
  if (!timestamp || !SQLITE_UTC_TIMESTAMP_RE.test(timestamp)) {
    return timestamp
  }
  return `${timestamp.replace(' ', 'T')}Z`
}

function exposeMessageTimestamps(message: MessageRow): MessageRow {
  // Why: SQLite stores UTC as timezone-less space format for SQL ordering, but RPC/CLI consumers need an explicit offset.
  return {
    ...message,
    created_at: exposeUtcTimestamp(message.created_at) ?? message.created_at,
    delivered_at: exposeUtcTimestamp(message.delivered_at)
  }
}

function exposeMessageListTimestamps(messages: MessageRow[]): MessageRow[] {
  return messages.map(exposeMessageTimestamps)
}

function exposeRunTimestamps(run: RunRow): RunRow {
  return {
    ...run,
    created_at: exposeUtcTimestamp(run.created_at) ?? run.created_at,
    updated_at: exposeUtcTimestamp(run.updated_at) ?? run.updated_at
  }
}

function encodeRunListCursor(run: RunRow): string {
  const cursor: RunListCursor = { createdAt: run.created_at, id: run.id }
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeRunListCursor(value: string): RunListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as RunListCursor).createdAt !== 'string' ||
      typeof (parsed as RunListCursor).id !== 'string'
    ) {
      throw new Error('invalid cursor shape')
    }
    return parsed as RunListCursor
  } catch {
    throw new OrchestrationError('cursor_invalid', 'The Run list cursor is invalid.')
  }
}

function exposeDeliveryTimestamps(delivery: DeliveryRow): DeliveryRow {
  return {
    ...delivery,
    created_at: exposeUtcTimestamp(delivery.created_at) ?? delivery.created_at,
    acknowledged_at: exposeUtcTimestamp(delivery.acknowledged_at)
  }
}

function exposeQuestionTimestamps(question: QuestionRow): QuestionRow {
  return {
    ...question,
    created_at: exposeUtcTimestamp(question.created_at) ?? question.created_at,
    answered_at: exposeUtcTimestamp(question.answered_at),
    closed_at: exposeUtcTimestamp(question.closed_at)
  }
}

function normalizeLegacyQuestionText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

function normalizeLegacyQuestionOptions(options: unknown): string {
  if (!Array.isArray(options) || !options.every((option) => typeof option === 'string')) {
    return '[]'
  }
  return JSON.stringify(options.map((option) => option.trim()))
}

function legacyMessageMatchesQuestion(
  message: MessageRow,
  question: string,
  options: string[],
  recipientHandles: readonly string[]
): boolean {
  if (
    !recipientHandles.includes(message.to_handle) ||
    normalizeLegacyQuestionText(message.body) !== normalizeLegacyQuestionText(question)
  ) {
    return false
  }
  try {
    const payload = JSON.parse(message.payload ?? '{}') as { options?: unknown }
    return (
      normalizeLegacyQuestionOptions(payload.options) === normalizeLegacyQuestionOptions(options)
    )
  } catch {
    return false
  }
}

export const LEGACY_RUN_ID = ORCHESTRATION_LEGACY_RUN_ID

export const LEGACY_CONTRACT_VERSION = 0
export const CURRENT_CONTRACT_VERSION = ORCHESTRATION_CONTRACT_VERSION

const MUTATION_RECEIPT_MAX_ROWS = 10_000
const MUTATION_RECEIPT_MAX_AGE_DAYS = 30

export type RunListPage = {
  runs: RunRow[]
  nextCursor: string | null
}

export type TaskRuntimeLineageRow = TaskRow & {
  creator_dispatch_id: string | null
  creator_dispatch_run_id: string | null
  creator_dispatch_pane_key: string | null
  creator_dispatch_process_incarnation: string | null
}

type RunListCursor = {
  createdAt: string
  id: string
}

// Schema versions: v2 'heartbeat'+last_heartbeat_at, v3 delivered_at, v4 task-creator terminal, v5 task_title/display_name, v6 pane identity, v7 lightweight Runs, v8 crash-safe Run deliveries, v9 durable question threads, v10 Dispatch capabilities, v11 durable mutation receipts, v12 composed worker state, v18 post-v6 version-skew repair, v19 adopted legacy Runs and compatibility receipts, v20 legacy question backfill, v21 legacy scheduler-loss provenance, v22 dispatch assignee lookup, v23 worker terminal resource ownership, v24 creator-incarnation authority, v25 active Dispatch handle lookup.
const SCHEMA_VERSION = 25

function hardenOrchestrationDatabaseFiles(dbPath: string | ':memory:'): void {
  if (dbPath === ':memory:' || process.platform === 'win32') {
    // Why: Windows protects these files through Orca's current-user-only userData DACL; POSIX mode bits are inert there.
    return
  }
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) {
      chmodSync(path, 0o600)
    }
  }
}

export class OrchestrationDb {
  private db: Database.Database

  // Why: the orchestration DB is created lazily for ALL users, but only the
  // small minority who dispatch work ever have dispatch_contexts rows. The
  // renderer graph publish rebuilds orchestration context on every 16ms tick
  // (buildAgentOrchestrationByPaneKey), issuing 2 queries per terminal. Cache
  // emptiness so the non-orchestration majority short-circuits the whole
  // per-terminal fan-out. Only createDispatchContext flips this false→true.
  private hasAnyDispatchContextsCache: boolean | undefined

  constructor(dbPath: string | ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    this.createTables()
    this.migrate()
    hardenOrchestrationDatabaseFiles(dbPath)
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id                    TEXT PRIMARY KEY,
        objective             TEXT NOT NULL,
        home_database         TEXT NOT NULL DEFAULT 'this_database',
        coordinator_handle    TEXT,
        coordinator_pane_key  TEXT,
        consumer_generation   INTEGER NOT NULL DEFAULT 0,
        legacy                INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id            TEXT NOT NULL,
        run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
        delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
          CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only')),
        from_handle   TEXT NOT NULL,
        to_handle     TEXT NOT NULL,
        subject       TEXT NOT NULL,
        body          TEXT NOT NULL DEFAULT '',
        type          TEXT NOT NULL DEFAULT 'status'
          CHECK(type IN (
            'status', 'dispatch', 'worker_done', 'merge_ready',
            'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
          )),
        priority      TEXT NOT NULL DEFAULT 'normal'
          CHECK(priority IN ('normal', 'high', 'urgent')),
        thread_id     TEXT,
        payload       TEXT,
        read          INTEGER NOT NULL DEFAULT 0,
        sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at  TEXT,
        sender_pane_key TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
      CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_handle, read);
      CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id);

      CREATE TABLE IF NOT EXISTS deliveries (
        id                    TEXT PRIMARY KEY,
        run_id                TEXT NOT NULL,
        consumer_generation   INTEGER NOT NULL,
        message_ids           TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'outstanding'
          CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        acknowledged_at       TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_one_outstanding
        ON deliveries(run_id) WHERE status = 'outstanding';
      CREATE INDEX IF NOT EXISTS idx_deliveries_run_created
        ON deliveries(run_id, created_at);

      CREATE TABLE IF NOT EXISTS mutation_receipts (
        caller_fingerprint  TEXT NOT NULL,
        request_id          TEXT NOT NULL,
        method              TEXT NOT NULL,
        payload_hash        TEXT NOT NULL,
        state               TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending', 'completed')),
        receipt             TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (caller_fingerprint, request_id)
      );

      CREATE TABLE IF NOT EXISTS worker_dispatches (
        dispatch_id            TEXT PRIMARY KEY,
        runtime_epoch          TEXT,
        state                  TEXT NOT NULL DEFAULT 'starting'
          CHECK(state IN (
            'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
            'stopping', 'stop_unknown', 'stopped', 'abandoned'
          )),
        stage                  TEXT NOT NULL DEFAULT 'accepted',
        worktree_id            TEXT,
        agent_terminal_handle  TEXT,
        setup_state            TEXT NOT NULL DEFAULT 'not_applicable',
        effects                TEXT NOT NULL DEFAULT '[]',
        residual_resources     TEXT NOT NULL DEFAULT '[]',
        start_options          TEXT NOT NULL DEFAULT '{}',
        last_error             TEXT,
        created_at             TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS worker_terminal_resources (
        id                       TEXT PRIMARY KEY,
        origin_dispatch_id       TEXT NOT NULL,
        owner_dispatch_id        TEXT NOT NULL,
        prior_owner_dispatch_ids TEXT NOT NULL DEFAULT '[]',
        worktree_id              TEXT,
        terminal_handle          TEXT NOT NULL,
        pane_key                 TEXT,
        process_incarnation      TEXT,
        host_scope               TEXT,
        ownership_state          TEXT NOT NULL DEFAULT 'owned'
          CHECK(ownership_state IN ('owned', 'transferred', 'user_owned', 'external', 'released')),
        release_state            TEXT NOT NULL DEFAULT 'not_requested'
          CHECK(release_state IN (
            'not_requested', 'retained', 'requested', 'releasing', 'released', 'unknown'
          )),
        retained_reason          TEXT,
        release_requested_at     TEXT,
        release_completed_at     TEXT,
        release_error            TEXT,
        archive_source           TEXT,
        archive_status           TEXT,
        created_at               TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_terminal_resources_owner
        ON worker_terminal_resources(owner_dispatch_id);
      CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_handle
        ON worker_terminal_resources(terminal_handle);
      CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_pane
        ON worker_terminal_resources(pane_key);
      CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_identity
        ON worker_terminal_resources(process_incarnation, host_scope);
      CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_release
        ON worker_terminal_resources(release_state);

      CREATE TABLE IF NOT EXISTS worker_terminal_archives (
        dispatch_id   TEXT PRIMARY KEY,
        resource_id   TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK(kind IN ('transcript_pin', 'terminal_tail')),
        content       TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS federated_dispatches (
        dispatch_id             TEXT PRIMARY KEY,
        environment_id          TEXT NOT NULL,
        environment_name        TEXT NOT NULL,
        peer_fingerprint        TEXT NOT NULL,
        remote_runtime_epoch    TEXT,
        protocol_version        INTEGER NOT NULL DEFAULT 1,
        remote_worktree_id      TEXT,
        remote_terminal_handle  TEXT,
        to_home_imported_sequence INTEGER NOT NULL DEFAULT 0,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS remote_dispatch_attachments (
        dispatch_id             TEXT PRIMARY KEY,
        task_id                 TEXT NOT NULL,
        home_peer_fingerprint   TEXT NOT NULL,
        protocol_version        INTEGER NOT NULL DEFAULT 1,
        runtime_epoch           TEXT NOT NULL,
        capability_hash         TEXT,
        pane_key                TEXT,
        process_incarnation     TEXT,
        state                   TEXT NOT NULL DEFAULT 'starting'
          CHECK(state IN (
            'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
            'stopping', 'stop_unknown', 'stopped', 'abandoned'
          )),
        stage                   TEXT NOT NULL DEFAULT 'accepted',
        worktree_id             TEXT,
        terminal_handle         TEXT,
        setup_state             TEXT NOT NULL DEFAULT 'not_applicable',
        effects                 TEXT NOT NULL DEFAULT '[]',
        residual_resources      TEXT NOT NULL DEFAULT '[]',
        to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0,
        last_error              TEXT,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS federation_relay_items (
        dispatch_id   TEXT NOT NULL,
        direction     TEXT NOT NULL CHECK(direction IN ('to_home', 'to_worker')),
        sequence      INTEGER NOT NULL,
        message_id    TEXT NOT NULL,
        kind          TEXT NOT NULL,
        payload       TEXT NOT NULL,
        byte_count    INTEGER NOT NULL,
        acked_at      TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (dispatch_id, direction, sequence),
        UNIQUE (dispatch_id, direction, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_federation_relay_pending
        ON federation_relay_items(dispatch_id, direction, acked_at, sequence);

      CREATE TABLE IF NOT EXISTS remote_questions (
        message_id        TEXT PRIMARY KEY,
        dispatch_id       TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'answered', 'closed')),
        answer_message_id TEXT,
        answer_body       TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        answered_at       TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_remote_questions_dispatch_status
        ON remote_questions(dispatch_id, status);

      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
        parent_id     TEXT,
        created_by_terminal_handle TEXT,
        created_by_pane_key TEXT,
        created_by_process_incarnation TEXT,
        created_by_run_generation INTEGER,
        task_title    TEXT,
        display_name  TEXT,
        spec          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN (
            'pending', 'ready', 'dispatched',
            'completed', 'failed', 'blocked'
          )),
        deps          TEXT NOT NULL DEFAULT '[]',
        result        TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

      CREATE TABLE IF NOT EXISTS dispatch_contexts (
        id                  TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
        task_id             TEXT NOT NULL,
        contract_version    INTEGER NOT NULL DEFAULT ${CURRENT_CONTRACT_VERSION},
        launch_token_hash   TEXT,
        assignee_handle     TEXT,
        assignee_pane_key   TEXT,
        capability_hash     TEXT,
        process_incarnation TEXT,
        capability_revoked_at TEXT,
        status              TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')),
        failure_count       INTEGER NOT NULL DEFAULT 0,
        last_failure        TEXT,
        dispatched_at       TEXT,
        completed_at        TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        last_heartbeat_at   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_dispatch_task ON dispatch_contexts(task_id);
      CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_contexts(status);
      CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_handle ON dispatch_contexts(assignee_handle);

      CREATE TABLE IF NOT EXISTS decision_gates (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
        task_id       TEXT NOT NULL,
        question      TEXT NOT NULL,
        options       TEXT NOT NULL DEFAULT '[]',
        status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'resolved', 'timeout')),
        resolution    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_gates_task ON decision_gates(task_id);
      CREATE INDEX IF NOT EXISTS idx_gates_status ON decision_gates(status);

      CREATE INDEX IF NOT EXISTS idx_runs_coordinator_pane_leaf
        ON runs(${RUN_PANE_KEY_MATCH_SUFFIX_SQL})
        WHERE coordinator_pane_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS coordinator_runs (
        id                  TEXT PRIMARY KEY,
        spec                TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'idle'
          CHECK(status IN ('idle', 'running', 'completed', 'failed')),
        coordinator_handle  TEXT NOT NULL,
        poll_interval_ms    INTEGER NOT NULL DEFAULT 2000,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at        TEXT,
        scheduler_lost_at   TEXT
      );
    `)
    this.createUndeliveredInboxIndexIfPossible()
  }

  // Why: CREATE TABLE IF NOT EXISTS won't alter existing DBs; migrate in a txn that bumps user_version only on success (atomic all-or-nothing).
  private migrate(): void {
    const storedVersion = this.db.pragma('user_version', { simple: true }) as number
    const current = resolveOrchestrationMigrationStartVersion(
      this.db,
      storedVersion,
      SCHEMA_VERSION
    )
    if (current >= SCHEMA_VERSION) {
      return
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      // v1 → v2: SQLite can't ALTER a CHECK, so rebuild messages to allow 'heartbeat'; fold in v3's delivered_at to skip a second rebuild.
      if (current < 2) {
        if (!this.hasColumn('dispatch_contexts', 'last_heartbeat_at')) {
          this.db.exec(`ALTER TABLE dispatch_contexts ADD COLUMN last_heartbeat_at TEXT`)
        }

        if (!this.messagesTypeCheckAllowsHeartbeat()) {
          // Why: recreate indexes here — DROP TABLE drops them; createTables re-runs only next startup, so skipping full-scans until restart.
          this.db.exec(`
            CREATE TABLE messages_new (
              id            TEXT NOT NULL,
              from_handle   TEXT NOT NULL,
              to_handle     TEXT NOT NULL,
              subject       TEXT NOT NULL,
              body          TEXT NOT NULL DEFAULT '',
              type          TEXT NOT NULL DEFAULT 'status'
                CHECK(type IN (
                  'status', 'dispatch', 'worker_done', 'merge_ready',
                  'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
                )),
              priority      TEXT NOT NULL DEFAULT 'normal'
                CHECK(priority IN ('normal', 'high', 'urgent')),
              thread_id     TEXT,
              payload       TEXT,
              read          INTEGER NOT NULL DEFAULT 0,
              sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at    TEXT NOT NULL DEFAULT (datetime('now')),
              delivered_at  TEXT
            );
            INSERT INTO messages_new (
              id, from_handle, to_handle, subject, body, type, priority,
              thread_id, payload, read, sequence, created_at
            )
            SELECT
              id, from_handle, to_handle, subject, body, type, priority,
              thread_id, payload, read, sequence, created_at
            FROM messages;
            DROP TABLE messages;
            ALTER TABLE messages_new RENAME TO messages;

            CREATE UNIQUE INDEX idx_messages_id ON messages(id);
            CREATE INDEX idx_inbox ON messages(to_handle, read);
            CREATE INDEX idx_messages_undelivered_inbox
              ON messages(to_handle, read, delivered_at, sequence);
            CREATE INDEX idx_thread ON messages(thread_id);
          `)
        }
      }

      // v2 → v3: add messages.delivered_at. hasColumn probe skips DBs that already got it via the v1→v2 rebuild (else a dup-column error aborts the txn).
      if (current < 3) {
        if (!this.hasColumn('messages', 'delivered_at')) {
          this.db.exec(`ALTER TABLE messages ADD COLUMN delivered_at TEXT`)
        }
      }
      if (current < 4) {
        if (!this.hasColumn('tasks', 'created_by_terminal_handle')) {
          this.db.exec(`ALTER TABLE tasks ADD COLUMN created_by_terminal_handle TEXT`)
        }
      }
      if (current < 5) {
        if (!this.hasColumn('tasks', 'task_title')) {
          this.db.exec(`ALTER TABLE tasks ADD COLUMN task_title TEXT`)
        }
        if (!this.hasColumn('tasks', 'display_name')) {
          this.db.exec(`ALTER TABLE tasks ADD COLUMN display_name TEXT`)
        }
      }
      if (current < 6) {
        if (!this.hasColumn('dispatch_contexts', 'assignee_pane_key')) {
          this.db.exec(`ALTER TABLE dispatch_contexts ADD COLUMN assignee_pane_key TEXT`)
        }
        if (!this.hasColumn('messages', 'sender_pane_key')) {
          this.db.exec(`ALTER TABLE messages ADD COLUMN sender_pane_key TEXT`)
        }
      }
      if (current < 7) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO runs (
               id, objective, home_database, consumer_generation, legacy
             ) VALUES (?, ?, 'this_database', 0, 1)`
          )
          .run(LEGACY_RUN_ID, 'Legacy orchestration state (inspect only)')
        for (const table of ['messages', 'tasks', 'dispatch_contexts', 'decision_gates']) {
          if (!this.hasColumn(table, 'run_id')) {
            this.db.exec(
              `ALTER TABLE ${table} ADD COLUMN run_id TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}'`
            )
          }
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_messages_run_sequence ON messages(run_id, sequence);
          CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status);
          CREATE INDEX IF NOT EXISTS idx_dispatch_run_status ON dispatch_contexts(run_id, status);
          CREATE INDEX IF NOT EXISTS idx_gates_run_status ON decision_gates(run_id, status);
          CREATE INDEX IF NOT EXISTS idx_runs_coordinator_pane ON runs(coordinator_pane_key);
        `)
      }
      if (current < 8) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS deliveries (
            id                    TEXT PRIMARY KEY,
            run_id                TEXT NOT NULL,
            consumer_generation   INTEGER NOT NULL,
            message_ids           TEXT NOT NULL,
            status                TEXT NOT NULL DEFAULT 'outstanding'
              CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
            created_at            TEXT NOT NULL DEFAULT (datetime('now')),
            acknowledged_at       TEXT
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_one_outstanding
            ON deliveries(run_id) WHERE status = 'outstanding';
      CREATE INDEX IF NOT EXISTS idx_deliveries_run_created
        ON deliveries(run_id, created_at);

      CREATE TABLE IF NOT EXISTS question_threads (
        message_id                TEXT PRIMARY KEY,
        run_id                    TEXT NOT NULL,
        dispatch_id               TEXT NOT NULL,
        asker_handle              TEXT NOT NULL,
        status                    TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'answered', 'closed')),
        answer_message_id         TEXT,
        answer_body               TEXT,
        answered_by_generation    INTEGER,
        created_at                TEXT NOT NULL DEFAULT (datetime('now')),
        answered_at               TEXT,
        closed_at                 TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_questions_dispatch_status
        ON question_threads(dispatch_id, status);
        `)
      }
      if (current < 9 && !this.messagesTypeCheckAllowsQuestion()) {
        this.db.exec(`
          CREATE TABLE messages_new (
            id              TEXT NOT NULL,
            run_id          TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
            from_handle     TEXT NOT NULL,
            to_handle       TEXT NOT NULL,
            subject         TEXT NOT NULL,
            body            TEXT NOT NULL DEFAULT '',
            type            TEXT NOT NULL DEFAULT 'status'
              CHECK(type IN (
                'status', 'dispatch', 'worker_done', 'merge_ready',
                'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
              )),
            priority        TEXT NOT NULL DEFAULT 'normal'
              CHECK(priority IN ('normal', 'high', 'urgent')),
            thread_id       TEXT,
            payload         TEXT,
            read            INTEGER NOT NULL DEFAULT 0,
            sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            delivered_at    TEXT,
            sender_pane_key TEXT
          );
          INSERT INTO messages_new (
            id, run_id, from_handle, to_handle, subject, body, type, priority,
            thread_id, payload, read, sequence, created_at, delivered_at, sender_pane_key
          )
          SELECT
            id, run_id, from_handle, to_handle, subject, body, type, priority,
            thread_id, payload, read, sequence, created_at, delivered_at, sender_pane_key
          FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_new RENAME TO messages;

          CREATE UNIQUE INDEX idx_messages_id ON messages(id);
          CREATE INDEX idx_inbox ON messages(to_handle, read);
          CREATE INDEX idx_thread ON messages(thread_id);
          CREATE INDEX idx_messages_run_sequence ON messages(run_id, sequence);
          CREATE INDEX idx_messages_undelivered_inbox
            ON messages(to_handle, read, delivered_at, sequence);
        `)
      }
      if (current < 10) {
        if (!this.hasColumn('dispatch_contexts', 'capability_hash')) {
          this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN capability_hash TEXT')
        }
        if (!this.hasColumn('dispatch_contexts', 'process_incarnation')) {
          this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN process_incarnation TEXT')
        }
        if (!this.hasColumn('dispatch_contexts', 'capability_revoked_at')) {
          this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN capability_revoked_at TEXT')
        }
      }
      if (current < 11) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mutation_receipts (
            caller_fingerprint  TEXT NOT NULL,
            request_id          TEXT NOT NULL,
            method              TEXT NOT NULL,
            payload_hash        TEXT NOT NULL,
            state               TEXT NOT NULL DEFAULT 'pending'
              CHECK(state IN ('pending', 'completed')),
            receipt             TEXT,
            created_at          TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (caller_fingerprint, request_id)
          );
        `)
      }
      if (current < 12) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS worker_dispatches (
            dispatch_id            TEXT PRIMARY KEY,
            runtime_epoch          TEXT,
            state                  TEXT NOT NULL DEFAULT 'starting'
              CHECK(state IN (
                'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
                'stopping', 'stop_unknown', 'stopped', 'abandoned'
              )),
            stage                  TEXT NOT NULL DEFAULT 'accepted',
            worktree_id            TEXT,
            agent_terminal_handle  TEXT,
            setup_state            TEXT NOT NULL DEFAULT 'not_applicable',
            effects                TEXT NOT NULL DEFAULT '[]',
            residual_resources     TEXT NOT NULL DEFAULT '[]',
            start_options          TEXT NOT NULL DEFAULT '{}',
            last_error             TEXT,
            created_at             TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `)
      }
      if (current < 13 && !this.hasColumn('worker_dispatches', 'runtime_epoch')) {
        this.db.exec('ALTER TABLE worker_dispatches ADD COLUMN runtime_epoch TEXT')
      }
      if (current < 14) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS federated_dispatches (
            dispatch_id             TEXT PRIMARY KEY,
            environment_id          TEXT NOT NULL,
            environment_name        TEXT NOT NULL,
            peer_fingerprint        TEXT NOT NULL,
            remote_runtime_epoch    TEXT,
            protocol_version        INTEGER NOT NULL DEFAULT 1,
            remote_worktree_id      TEXT,
            remote_terminal_handle  TEXT,
            to_home_imported_sequence INTEGER NOT NULL DEFAULT 0,
            created_at              TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE TABLE IF NOT EXISTS remote_dispatch_attachments (
            dispatch_id             TEXT PRIMARY KEY,
            task_id                 TEXT NOT NULL,
            home_peer_fingerprint   TEXT NOT NULL,
            protocol_version        INTEGER NOT NULL DEFAULT 1,
            runtime_epoch           TEXT NOT NULL,
            capability_hash         TEXT,
            pane_key                TEXT,
            process_incarnation     TEXT,
            state                   TEXT NOT NULL DEFAULT 'starting'
              CHECK(state IN (
                'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
                'stopping', 'stop_unknown', 'stopped', 'abandoned'
              )),
            stage                   TEXT NOT NULL DEFAULT 'accepted',
            worktree_id             TEXT,
            terminal_handle         TEXT,
            setup_state             TEXT NOT NULL DEFAULT 'not_applicable',
            effects                 TEXT NOT NULL DEFAULT '[]',
            residual_resources      TEXT NOT NULL DEFAULT '[]',
            to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0,
            last_error              TEXT,
            created_at              TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `)
      }
      if (current < 15) {
        if (!this.hasColumn('federated_dispatches', 'to_home_imported_sequence')) {
          this.db.exec(
            'ALTER TABLE federated_dispatches ADD COLUMN to_home_imported_sequence INTEGER NOT NULL DEFAULT 0'
          )
        }
        if (!this.hasColumn('remote_dispatch_attachments', 'to_worker_imported_sequence')) {
          this.db.exec(
            'ALTER TABLE remote_dispatch_attachments ADD COLUMN to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0'
          )
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS federation_relay_items (
            dispatch_id   TEXT NOT NULL,
            direction     TEXT NOT NULL CHECK(direction IN ('to_home', 'to_worker')),
            sequence      INTEGER NOT NULL,
            message_id    TEXT NOT NULL,
            kind          TEXT NOT NULL,
            payload       TEXT NOT NULL,
            byte_count    INTEGER NOT NULL,
            acked_at      TEXT,
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (dispatch_id, direction, sequence),
            UNIQUE (dispatch_id, direction, message_id)
          );
          CREATE INDEX IF NOT EXISTS idx_federation_relay_pending
            ON federation_relay_items(dispatch_id, direction, acked_at, sequence);
        `)
      }
      if (current < 16) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS remote_questions (
            message_id        TEXT PRIMARY KEY,
            dispatch_id       TEXT NOT NULL,
            status            TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending', 'answered', 'closed')),
            answer_message_id TEXT,
            answer_body       TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now')),
            answered_at       TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_remote_questions_dispatch_status
            ON remote_questions(dispatch_id, status);
        `)
      }
      if (current < 17 && !this.hasColumn('remote_dispatch_attachments', 'protocol_version')) {
        this.db.exec(
          'ALTER TABLE remote_dispatch_attachments ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1'
        )
      }
      if (current < 19) {
        this.migrateLegacyContractStorage()
      }
      if (current < 20) {
        this.backfillLegacyQuestionThreads()
      }
      if (current < 21) {
        this.migrateLegacySchedulerLossProvenance()
      }
      if (current < 22) {
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_handle
            ON dispatch_contexts(assignee_handle);
        `)
      }
      if (current < 23) {
        this.backfillWorkerTerminalResources()
      }
      if (current < 24) {
        if (!this.hasColumn('tasks', 'created_by_pane_key')) {
          this.db.exec('ALTER TABLE tasks ADD COLUMN created_by_pane_key TEXT')
        }
        if (!this.hasColumn('tasks', 'created_by_process_incarnation')) {
          this.db.exec('ALTER TABLE tasks ADD COLUMN created_by_process_incarnation TEXT')
        }
        if (!this.hasColumn('tasks', 'created_by_run_generation')) {
          this.db.exec('ALTER TABLE tasks ADD COLUMN created_by_run_generation INTEGER')
        }
      }
      if (current < 25) {
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_dispatch_active_assignee_handle
            ON dispatch_contexts(assignee_handle)
            WHERE assignee_handle IS NOT NULL AND status IN ('pending', 'dispatched');
        `)
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_pane_leaf
          ON dispatch_contexts(${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL})
          WHERE assignee_pane_key IS NOT NULL AND status IN ('pending', 'dispatched');
      `)
      this.createUndeliveredInboxIndexIfPossible()

      this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private migrateLegacyContractStorage(): void {
    if (!this.hasColumn('dispatch_contexts', 'contract_version')) {
      this.db.exec(
        `ALTER TABLE dispatch_contexts
         ADD COLUMN contract_version INTEGER NOT NULL DEFAULT ${CURRENT_CONTRACT_VERSION}`
      )
    }
    if (!this.hasColumn('dispatch_contexts', 'launch_token_hash')) {
      this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN launch_token_hash TEXT')
    }
    if (!this.hasColumn('messages', 'delivery_contract')) {
      this.db.exec(
        `ALTER TABLE messages
         ADD COLUMN delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
         CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only'))`
      )
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_delivery_contract
        ON messages(run_id, delivery_contract, to_handle, read, sequence);

      CREATE TABLE IF NOT EXISTS legacy_adoptions (
        source_run_id        TEXT PRIMARY KEY,
        adopted_run_id       TEXT UNIQUE NOT NULL,
        scheduler_state_lost INTEGER NOT NULL,
        adopted_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS legacy_compatibility_principals (
        id                  TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL,
        dispatch_id         TEXT,
        role                TEXT NOT NULL CHECK(role IN ('worker', 'coordinator')),
        host_scope          TEXT NOT NULL,
        terminal_handle     TEXT NOT NULL,
        pane_key            TEXT NOT NULL,
        launch_token_hash   TEXT NOT NULL,
        process_incarnation TEXT,
        status              TEXT NOT NULL
          CHECK(status IN ('committed', 'settled', 'revoked')),
        CHECK(
          (role = 'worker' AND dispatch_id IS NOT NULL) OR
          (role = 'coordinator' AND dispatch_id IS NULL)
        ),
        UNIQUE(role, run_id, dispatch_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_principal_coordinator
        ON legacy_compatibility_principals(run_id)
        WHERE role = 'coordinator';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_principal_dispatch
        ON legacy_compatibility_principals(dispatch_id)
        WHERE role = 'worker';

      CREATE TABLE IF NOT EXISTS legacy_operation_receipts (
        principal_id   TEXT NOT NULL,
        operation_key  TEXT NOT NULL,
        method         TEXT NOT NULL,
        payload_hash   TEXT NOT NULL,
        effect_id      TEXT NOT NULL,
        response_json  TEXT NOT NULL,
        completed_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(principal_id, operation_key)
      );

      CREATE TABLE IF NOT EXISTS legacy_mail_receipts (
        principal_id    TEXT NOT NULL,
        message_id      TEXT NOT NULL,
        acknowledged_at TEXT,
        PRIMARY KEY(principal_id, message_id)
      );
    `)

    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET contract_version = ?
         WHERE run_id = ? AND capability_hash IS NULL`
      )
      .run(LEGACY_CONTRACT_VERSION, LEGACY_RUN_ID)
    this.classifyLegacyMessageContracts(LEGACY_RUN_ID, false)
    this.ensureLegacySchedulerLossColumn()
    this.adoptLegacyRunIfNeeded()
  }

  private classifyLegacyMessageContracts(runId: string, adoptedOnly: boolean): void {
    const contractFilter = adoptedOnly
      ? " AND delivery_contract IN ('legacy_direct', 'audit_only')"
      : ''
    this.db
      .prepare(
        `UPDATE messages SET delivery_contract = 'legacy_direct'
         WHERE run_id = ?${contractFilter}`
      )
      .run(runId)
    const rows = this.db
      .prepare(`SELECT id, payload FROM messages WHERE run_id = ?${contractFilter}`)
      .all(runId) as { id: string; payload: string | null }[]
    const markAuditOnly = this.db.prepare(
      "UPDATE messages SET delivery_contract = 'audit_only' WHERE id = ? AND run_id = ?"
    )
    for (const row of rows) {
      if (hasLifecycleRejectionMarker(row.payload)) {
        markAuditOnly.run(row.id, runId)
      }
    }
  }

  private migrateLegacySchedulerLossProvenance(): void {
    this.ensureLegacySchedulerLossColumn()
    this.adoptLegacyRunIfNeeded()
    const adoption = this.getLegacyAdoption()
    if (adoption) {
      this.classifyLegacyMessageContracts(adoption.adopted_run_id, true)
    }
  }

  private ensureLegacySchedulerLossColumn(): void {
    if (!this.hasColumn('coordinator_runs', 'scheduler_lost_at')) {
      this.db.exec('ALTER TABLE coordinator_runs ADD COLUMN scheduler_lost_at TEXT')
    }
  }

  private backfillLegacyQuestionThreads(): void {
    const messages = this.db
      .prepare(
        `SELECT id, run_id, from_handle, to_handle, payload, created_at, sequence
         FROM messages
         WHERE type = 'decision_gate'
           AND delivery_contract IN ('legacy_direct', 'current_delivery')
         ORDER BY sequence`
      )
      .all() as {
      id: string
      run_id: string
      from_handle: string
      to_handle: string
      payload: string | null
      created_at: string
      sequence: number
    }[]
    const getDispatch = this.db.prepare(
      'SELECT id, run_id, task_id FROM dispatch_contexts WHERE id = ? AND contract_version = ?'
    )
    const getDispatchesForLegacyQuestion = this.db.prepare(
      `SELECT id, run_id, task_id
       FROM dispatch_contexts
       WHERE contract_version = ? AND assignee_handle = ?
         AND (? IS NULL OR task_id = ?)
         AND created_at <= ?
         AND (completed_at IS NULL OR completed_at >= ?)
       ORDER BY rowid
       LIMIT 2`
    )
    const getAnswer = this.db.prepare(
      `SELECT id, body, created_at
       FROM messages
       WHERE run_id = ?
         AND thread_id = ?
         AND delivery_contract IN ('legacy_direct', 'current_delivery')
         AND from_handle = ?
         AND to_handle IN (?, ?)
         AND sequence > ?
       ORDER BY sequence
       LIMIT 1`
    )
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO question_threads (
         message_id, run_id, dispatch_id, asker_handle, status,
         answer_message_id, answer_body, created_at, answered_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const message of messages) {
      let payload: { taskId?: unknown; dispatchId?: unknown }
      try {
        payload = JSON.parse(message.payload ?? '{}') as {
          taskId?: unknown
          dispatchId?: unknown
        }
      } catch {
        continue
      }
      const inferredDispatches =
        typeof payload.dispatchId === 'string'
          ? []
          : (getDispatchesForLegacyQuestion.all(
              LEGACY_CONTRACT_VERSION,
              message.from_handle,
              typeof payload.taskId === 'string' ? payload.taskId : null,
              typeof payload.taskId === 'string' ? payload.taskId : null,
              message.created_at,
              message.created_at
            ) as { id: string; run_id: string; task_id: string }[])
      const dispatch =
        typeof payload.dispatchId === 'string'
          ? (getDispatch.get(payload.dispatchId, LEGACY_CONTRACT_VERSION) as
              | { id: string; run_id: string; task_id: string }
              | undefined)
          : inferredDispatches.length === 1
            ? inferredDispatches[0]
            : undefined
      if (
        !dispatch ||
        (typeof payload.taskId === 'string' && payload.taskId !== dispatch.task_id) ||
        (message.run_id !== LEGACY_RUN_ID && message.run_id !== dispatch.run_id)
      ) {
        continue
      }
      const answer = getAnswer.get(
        message.run_id,
        message.id,
        message.to_handle,
        message.from_handle,
        `dispatch:${dispatch.id}`,
        message.sequence
      ) as { id: string; body: string; created_at: string } | undefined
      insert.run(
        message.id,
        dispatch.run_id,
        dispatch.id,
        message.from_handle,
        answer ? 'answered' : 'pending',
        answer?.id ?? null,
        answer?.body ?? null,
        message.created_at,
        answer?.created_at ?? null
      )
    }
    const adoption = this.getLegacyAdoption()
    const coordinator = adoption
      ? this.getLegacyCoordinatorPrincipal(adoption.adopted_run_id)
      : undefined
    if (adoption && coordinator?.status === 'revoked') {
      this.promoteLegacyCoordinatorMailForTakeover(
        adoption.adopted_run_id,
        coordinator.terminal_handle
      )
    }
  }

  private adoptLegacyRunIfNeeded(): void {
    const existing = this.db
      .prepare('SELECT * FROM legacy_adoptions WHERE source_run_id = ?')
      .get(LEGACY_RUN_ID) as LegacyAdoptionRow | undefined
    const hasGraph = this.db
      .prepare(
        `SELECT 1
         WHERE EXISTS(SELECT 1 FROM tasks WHERE run_id = ?)
            OR EXISTS(SELECT 1 FROM dispatch_contexts WHERE run_id = ?)
            OR EXISTS(SELECT 1 FROM decision_gates WHERE run_id = ?)
            OR EXISTS(SELECT 1 FROM messages WHERE run_id = ?)
            OR EXISTS(SELECT 1 FROM question_threads WHERE run_id = ?)
            OR EXISTS(SELECT 1 FROM deliveries WHERE run_id = ?)`
      )
      .get(LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID)
    if (!existing && !hasGraph) {
      return
    }

    const adoptedRunId = existing?.adopted_run_id ?? generateId('run')
    this.db
      .prepare(
        `INSERT OR IGNORE INTO runs (
           id, objective, home_database, consumer_generation, legacy
         ) VALUES (?, ?, 'this_database', 0, 0)`
      )
      .run(adoptedRunId, 'Recovered orchestration work from a contract update')
    this.db
      .prepare(
        `INSERT OR IGNORE INTO legacy_adoptions (
           source_run_id, adopted_run_id, scheduler_state_lost
         ) VALUES (?, ?, 1)`
      )
      .run(LEGACY_RUN_ID, adoptedRunId)
    this.db
      .prepare(
        `UPDATE coordinator_runs
         SET status = 'failed',
             completed_at = COALESCE(
               completed_at,
               (SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?)
             ),
             scheduler_lost_at = (
               SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?
             )
         WHERE status = 'running'
           AND julianday(created_at) <= julianday((
             SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?
           ))`
      )
      .run(LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID)

    this.db
      .prepare(
        `UPDATE deliveries SET status = 'fenced'
         WHERE run_id = ? AND status = 'outstanding'`
      )
      .run(LEGACY_RUN_ID)
    for (const table of [
      'tasks',
      'dispatch_contexts',
      'decision_gates',
      'messages',
      'question_threads',
      'deliveries'
    ]) {
      this.db
        .prepare(`UPDATE ${table} SET run_id = ? WHERE run_id = ?`)
        .run(adoptedRunId, LEGACY_RUN_ID)
    }
    this.db
      .prepare(
        `UPDATE runs
         SET objective = 'Legacy orchestration state (adopted; inspect only)',
             coordinator_handle = NULL, coordinator_pane_key = NULL,
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(LEGACY_RUN_ID)

    const mismatch = this.db
      .prepare(
        `WITH migration_runs(run_id) AS (VALUES (?), (?))
         SELECT 1
         WHERE EXISTS(
           SELECT 1 FROM dispatch_contexts d
           INNER JOIN tasks t ON t.id = d.task_id
           WHERE d.run_id <> t.run_id
             AND (
               d.run_id IN (SELECT run_id FROM migration_runs)
               OR t.run_id IN (SELECT run_id FROM migration_runs)
             )
         )
            OR EXISTS(
              SELECT 1 FROM decision_gates g
              INNER JOIN tasks t ON t.id = g.task_id
              WHERE g.run_id <> t.run_id
                AND (
                  g.run_id IN (SELECT run_id FROM migration_runs)
                  OR t.run_id IN (SELECT run_id FROM migration_runs)
                )
            )
            OR EXISTS(
              SELECT 1 FROM question_threads q
              INNER JOIN dispatch_contexts d ON d.id = q.dispatch_id
              WHERE q.run_id <> d.run_id
                AND (
                  q.run_id IN (SELECT run_id FROM migration_runs)
                  OR d.run_id IN (SELECT run_id FROM migration_runs)
                )
            )
            OR EXISTS(
              SELECT 1 FROM deliveries d
              INNER JOIN json_each(d.message_ids) ids
              INNER JOIN messages m ON m.id = ids.value
              WHERE d.run_id <> m.run_id
                AND (
                  d.run_id IN (SELECT run_id FROM migration_runs)
                  OR m.run_id IN (SELECT run_id FROM migration_runs)
                )
            )`
      )
      .get(LEGACY_RUN_ID, adoptedRunId)
    if (mismatch) {
      throw new Error('Legacy orchestration adoption produced inconsistent Run ownership.')
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.pragma(`table_info(${table})`) as { name: string }[]
    return rows.some((r) => r.name === column)
  }

  private createUndeliveredInboxIndexIfPossible(): void {
    if (!this.hasColumn('messages', 'delivered_at')) {
      return
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_undelivered_inbox
        ON messages(to_handle, read, delivered_at, sequence)
    `)
  }

  // Why: sqlite_master holds the table's CREATE SQL incl. the CHECK — cheapest reliable probe for whether it already allows 'heartbeat'.
  private messagesTypeCheckAllowsHeartbeat(): boolean {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get() as { sql: string } | undefined
    return !!row && row.sql.includes("'heartbeat'")
  }

  private messagesTypeCheckAllowsQuestion(): boolean {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get() as { sql: string } | undefined
    return !!row && row.sql.includes("'question'")
  }

  // ── Durable mutation receipts ──

  private ensureMutationReceiptCapacity(): void {
    this.db
      .prepare(
        `DELETE FROM mutation_receipts
         WHERE state = 'completed'
           AND updated_at < datetime('now', ?)`
      )
      .run(`-${MUTATION_RECEIPT_MAX_AGE_DAYS} days`)

    const row = this.db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get() as {
      count: number
    }
    const completedToRemove = row.count - MUTATION_RECEIPT_MAX_ROWS + 1
    if (completedToRemove > 0) {
      this.db
        .prepare(
          `DELETE FROM mutation_receipts
           WHERE rowid IN (
             SELECT rowid FROM mutation_receipts
             WHERE state = 'completed'
             ORDER BY updated_at ASC, rowid ASC
             LIMIT ?
           )`
        )
        .run(completedToRemove)
    }

    const retained = this.db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get() as {
      count: number
    }
    if (retained.count >= MUTATION_RECEIPT_MAX_ROWS) {
      throw new OrchestrationError(
        'mutation_ledger_full',
        'The durable mutation ledger is full of unresolved operations. Resolve or inspect them before starting another mutation.'
      )
    }
  }

  beginMutationReceipt(params: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
  }):
    | { disposition: 'started'; row: MutationReceiptRow }
    | { disposition: 'pending'; row: MutationReceiptRow }
    | { disposition: 'completed'; row: MutationReceiptRow } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.getMutationReceipt(params.callerFingerprint, params.requestId)
      if (existing) {
        if (existing.method !== params.method || existing.payload_hash !== params.payloadHash) {
          throw new OrchestrationError(
            'request_mismatch',
            `Mutation request ${params.requestId} was already used with different input.`
          )
        }
        this.db.exec('COMMIT')
        return { disposition: existing.state, row: existing }
      }
      this.ensureMutationReceiptCapacity()
      this.db
        .prepare(
          `INSERT INTO mutation_receipts (
             caller_fingerprint, request_id, method, payload_hash, state
           ) VALUES (?, ?, ?, ?, 'pending')`
        )
        .run(params.callerFingerprint, params.requestId, params.method, params.payloadHash)
      const row = this.getMutationReceipt(params.callerFingerprint, params.requestId)
      this.db.exec('COMMIT')
      return { disposition: 'started', row: row as MutationReceiptRow }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  completeMutationReceipt(params: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
    receipt: string
  }): MutationReceiptRow {
    const result = this.db
      .prepare(
        `UPDATE mutation_receipts
         SET state = 'completed', receipt = ?, updated_at = datetime('now')
         WHERE caller_fingerprint = ? AND request_id = ? AND method = ?
           AND payload_hash = ?`
      )
      .run(
        params.receipt,
        params.callerFingerprint,
        params.requestId,
        params.method,
        params.payloadHash
      )
    const row = this.getMutationReceipt(params.callerFingerprint, params.requestId)
    if (result.changes !== 1 || !row) {
      throw new OrchestrationError(
        'request_mismatch',
        `Mutation request ${params.requestId} no longer matches its pending operation.`
      )
    }
    return row
  }

  discardPendingMutationReceipt(callerFingerprint: string, requestId: string): void {
    this.db
      .prepare(
        `DELETE FROM mutation_receipts
         WHERE caller_fingerprint = ? AND request_id = ? AND state = 'pending'`
      )
      .run(callerFingerprint, requestId)
  }

  getMutationReceipt(callerFingerprint: string, requestId: string): MutationReceiptRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM mutation_receipts
         WHERE caller_fingerprint = ? AND request_id = ?`
      )
      .get(callerFingerprint, requestId) as MutationReceiptRow | undefined
  }

  // ── Legacy adoption and compatibility principals ──

  getLegacyAdoption(): LegacyAdoptionRow | undefined {
    return this.db
      .prepare('SELECT * FROM legacy_adoptions WHERE source_run_id = ?')
      .get(LEGACY_RUN_ID) as LegacyAdoptionRow | undefined
  }

  commitLegacyCompatibilityPrincipal(params: {
    runId: string
    dispatchId?: string
    role: LegacyPrincipalRole
    hostScope: string
    terminalHandle: string
    paneKey: string
    launchTokenHash: string
    processIncarnation?: string
  }): { principal: LegacyCompatibilityPrincipalRow; duplicate: boolean } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const adoption = this.getLegacyAdoption()
      if (!adoption || adoption.adopted_run_id !== params.runId) {
        throw new OrchestrationError(
          'request_mismatch',
          `Run ${params.runId} is not the adopted legacy Run.`
        )
      }
      const dispatchId = params.role === 'worker' ? (params.dispatchId ?? null) : null
      let initialStatus: 'committed' | 'settled' = 'committed'
      if (params.role === 'worker') {
        const dispatch = dispatchId ? this.getDispatchContextById(dispatchId) : undefined
        if (
          !dispatch ||
          dispatch.run_id !== params.runId ||
          dispatch.contract_version !== LEGACY_CONTRACT_VERSION
        ) {
          throw new OrchestrationError(
            'request_mismatch',
            `Dispatch ${dispatchId ?? '(missing)'} is not a legacy attempt in this Run.`
          )
        }
        initialStatus = ['pending', 'dispatched'].includes(dispatch.status)
          ? 'committed'
          : 'settled'
      } else if (params.dispatchId) {
        throw new OrchestrationError(
          'request_mismatch',
          'A coordinator compatibility principal cannot name a Dispatch.'
        )
      }

      const existing = this.db
        .prepare(
          `SELECT * FROM legacy_compatibility_principals
           WHERE role = ? AND run_id = ? AND dispatch_id IS ?`
        )
        .get(params.role, params.runId, dispatchId) as LegacyCompatibilityPrincipalRow | undefined
      if (existing) {
        const same =
          existing.host_scope === params.hostScope &&
          existing.terminal_handle === params.terminalHandle &&
          existing.pane_key === params.paneKey &&
          existing.launch_token_hash === params.launchTokenHash &&
          existing.process_incarnation === (params.processIncarnation ?? null)
        if (!same) {
          throw new OrchestrationError(
            'request_mismatch',
            `The ${params.role} compatibility principal is already committed to different proof.`
          )
        }
        if (existing.status === 'revoked') {
          throw new OrchestrationError(
            'legacy_read_only',
            `The ${params.role} compatibility principal has been revoked. No effects were applied.`,
            { effectsApplied: false }
          )
        }
        this.db.exec('COMMIT')
        return { principal: existing, duplicate: true }
      }
      if (
        params.role === 'coordinator' &&
        !this.resolveLegacyCoordinatorCandidate({
          runId: params.runId,
          terminalHandle: params.terminalHandle,
          paneKey: params.paneKey
        })
      ) {
        throw new OrchestrationError(
          'legacy_read_only',
          'This retained legacy coordinator no longer has lifecycle authority. No effects were applied.',
          { effectsApplied: false }
        )
      }

      const id = generateId('legacy_principal')
      this.db
        .prepare(
          `INSERT INTO legacy_compatibility_principals (
             id, run_id, dispatch_id, role, host_scope, terminal_handle,
             pane_key, launch_token_hash, process_incarnation, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          params.runId,
          dispatchId,
          params.role,
          params.hostScope,
          params.terminalHandle,
          params.paneKey,
          params.launchTokenHash,
          params.processIncarnation ?? null,
          initialStatus
        )
      const principal = this.getLegacyCompatibilityPrincipal(id) as LegacyCompatibilityPrincipalRow
      if (principal.status === 'committed') {
        this.initializeLegacyRecoveryCohort(principal)
      }
      this.db.exec('COMMIT')
      return { principal, duplicate: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getLegacyCompatibilityPrincipal(id: string): LegacyCompatibilityPrincipalRow | undefined {
    return this.db.prepare('SELECT * FROM legacy_compatibility_principals WHERE id = ?').get(id) as
      | LegacyCompatibilityPrincipalRow
      | undefined
  }

  listLegacyCompatibilityPrincipals(runId: string): LegacyCompatibilityPrincipalRow[] {
    return this.db
      .prepare(
        `SELECT * FROM legacy_compatibility_principals
         WHERE run_id = ? ORDER BY rowid`
      )
      .all(runId) as LegacyCompatibilityPrincipalRow[]
  }

  getLegacyCoordinatorPrincipal(runId: string): LegacyCompatibilityPrincipalRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM legacy_compatibility_principals
         WHERE run_id = ? AND role = 'coordinator'`
      )
      .get(runId) as LegacyCompatibilityPrincipalRow | undefined
  }

  resolveLegacyCompatibilityPrincipalByIdentity(params: {
    runId: string
    role: LegacyPrincipalRole
    terminalHandle?: string
    paneKey?: string
  }): LegacyCompatibilityPrincipalRow | undefined {
    if (!params.terminalHandle && !params.paneKey) {
      return undefined
    }
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM legacy_compatibility_principals
           WHERE run_id = ? AND role = ? AND status IN ('committed', 'settled')
           ORDER BY rowid`
        )
        .all(params.runId, params.role) as LegacyCompatibilityPrincipalRow[]
    ).filter((principal) =>
      params.paneKey
        ? isEquivalentPaneKey(principal.pane_key, params.paneKey)
        : principal.terminal_handle === params.terminalHandle
    )
    if (rows.length > 1) {
      throw new OrchestrationError(
        'operation_unknown',
        'Multiple legacy principals match this process identity.'
      )
    }
    return rows[0]
  }

  resolveLegacyWorkerCandidate(params: {
    runId?: string
    terminalHandle?: string
    paneKey?: string
    dispatchId?: string
    taskId?: string
  }): { dispatch: DispatchContextRow } | undefined {
    if (!params.runId || (!params.terminalHandle && !params.paneKey)) {
      return undefined
    }
    const rows = (
      params.dispatchId
        ? [this.getDispatchContextById(params.dispatchId)].filter(
            (row): row is DispatchContextRow => row !== undefined
          )
        : (this.db
            .prepare(
              `SELECT * FROM dispatch_contexts
               WHERE run_id = ? AND contract_version = ?
                 AND status IN ('pending', 'dispatched')
               ORDER BY rowid`
            )
            .all(params.runId, LEGACY_CONTRACT_VERSION) as DispatchContextRow[])
    ).filter(
      (dispatch) =>
        dispatch.run_id === params.runId &&
        dispatch.contract_version === LEGACY_CONTRACT_VERSION &&
        (!params.taskId || dispatch.task_id === params.taskId) &&
        (params.paneKey
          ? Boolean(
              dispatch.assignee_pane_key &&
              isEquivalentPaneKey(dispatch.assignee_pane_key, params.paneKey)
            )
          : dispatch.assignee_handle === params.terminalHandle)
    )
    if (rows.length > 1) {
      throw new OrchestrationError(
        'operation_unknown',
        'Multiple active legacy Dispatches match this process identity.'
      )
    }
    if (params.dispatchId && rows.length === 0) {
      const target = this.getDispatchContextById(params.dispatchId)
      if (target?.contract_version === LEGACY_CONTRACT_VERSION) {
        throw new OrchestrationError(
          'legacy_read_only',
          `Dispatch ${params.dispatchId} is retained but this process cannot prove ownership.`
        )
      }
    }
    return rows[0] ? { dispatch: rows[0] } : undefined
  }

  resolveLegacyCoordinatorCandidate(params: {
    runId: string
    terminalHandle?: string
    paneKey?: string
  }): { terminalHandle: string; paneKey: string } | undefined {
    if (!params.terminalHandle || !params.paneKey) {
      return undefined
    }
    const run = this.getRunRaw(params.runId)
    const principal = this.getLegacyCoordinatorPrincipal(params.runId)
    if (principal) {
      if (
        principal.status !== 'committed' ||
        principal.terminal_handle !== params.terminalHandle ||
        !isEquivalentPaneKey(principal.pane_key, params.paneKey) ||
        (run?.coordinator_pane_key !== null &&
          (run?.coordinator_handle !== principal.terminal_handle ||
            !isEquivalentPaneKey(run.coordinator_pane_key, principal.pane_key)))
      ) {
        return undefined
      }
      return { terminalHandle: params.terminalHandle, paneKey: params.paneKey }
    }
    // Why: the first current binding durably fences uncommitted legacy processes.
    if (
      !run ||
      run.coordinator_pane_key !== null ||
      this.getUniqueLegacyCoordinatorHandle(params.runId) !== params.terminalHandle
    ) {
      return undefined
    }
    return { terminalHandle: params.terminalHandle, paneKey: params.paneKey }
  }

  isLegacyCoordinatorHandle(runId: string, terminalHandle: string): boolean {
    const principal = this.getLegacyCoordinatorPrincipal(runId)
    if (principal) {
      return principal.terminal_handle === terminalHandle
    }
    return this.getUniqueLegacyCoordinatorHandle(runId) === terminalHandle
  }

  findLegacyWorkerCompletion(params: {
    principalId: string
    taskId: string
    recipientHandle: string
    subject: string
    body: string
    payload: string | null
  }): MessageRow | undefined {
    const principal = this.getLegacyCompatibilityPrincipal(params.principalId)
    if (!principal || principal.role !== 'worker' || !principal.dispatch_id) {
      throw new OrchestrationError('request_mismatch', 'Legacy worker principal was not found.')
    }
    const runAddress = `run:${principal.run_id}`
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE run_id = ?
           AND (
             (delivery_contract = 'legacy_direct' AND to_handle = ?) OR
             (delivery_contract = 'current_delivery' AND to_handle = ?)
           )
           AND from_handle = ? AND type = 'worker_done'
           AND subject = ? AND body = ? AND payload IS ?
         ORDER BY sequence`
      )
      .all(
        principal.run_id,
        params.recipientHandle,
        runAddress,
        principal.terminal_handle,
        params.subject,
        params.body,
        params.payload
      ) as MessageRow[]
    const matches = rows.filter((message) => {
      try {
        const payload = JSON.parse(message.payload ?? '{}') as {
          taskId?: unknown
          dispatchId?: unknown
        }
        return payload.taskId === params.taskId && payload.dispatchId === principal.dispatch_id
      } catch {
        return false
      }
    })
    if (matches.length > 1) {
      throw new OrchestrationError(
        'operation_unknown',
        'Multiple matching legacy worker completions exist.'
      )
    }
    return matches[0] ? exposeMessageTimestamps(matches[0]) : undefined
  }

  hasPendingCurrentDelivery(runId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM messages
           WHERE run_id = ? AND to_handle = ?
             AND delivery_contract = 'current_delivery' AND read = 0
           LIMIT 1`
        )
        .get(runId, `run:${runId}`)
    )
  }

  setLegacyCompatibilityPrincipalStatus(
    id: string,
    status: 'settled' | 'revoked'
  ): LegacyCompatibilityPrincipalRow | undefined {
    this.db
      .prepare(
        `UPDATE legacy_compatibility_principals
         SET status = ?
         WHERE id = ? AND status = 'committed'`
      )
      .run(status, id)
    return this.getLegacyCompatibilityPrincipal(id)
  }

  getLegacyOperationReceipt(
    principalId: string,
    operationKey: string
  ): LegacyOperationReceiptRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM legacy_operation_receipts
         WHERE principal_id = ? AND operation_key = ?`
      )
      .get(principalId, operationKey) as LegacyOperationReceiptRow | undefined
  }

  private requireCommittedLegacyPrincipal(
    principalId: string,
    role?: LegacyPrincipalRole
  ): LegacyCompatibilityPrincipalRow {
    const principal = this.getLegacyCompatibilityPrincipal(principalId)
    if (!principal || principal.status !== 'committed' || (role && principal.role !== role)) {
      throw new OrchestrationError(
        'request_mismatch',
        `Legacy compatibility principal ${principalId} is not committed for this operation.`
      )
    }
    return principal
  }

  private requireLegacyMailPrincipal(
    principalId: string,
    role?: LegacyPrincipalRole
  ): LegacyCompatibilityPrincipalRow {
    const principal = this.getLegacyCompatibilityPrincipal(principalId)
    if (
      !principal ||
      !['committed', 'settled'].includes(principal.status) ||
      (role && principal.role !== role)
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Legacy compatibility principal ${principalId} cannot access retained mail.`
      )
    }
    return principal
  }

  private initializeLegacyRecoveryCohort(principal: LegacyCompatibilityPrincipalRow): void {
    if (principal.role === 'worker') {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO legacy_mail_receipts (
             principal_id, message_id, acknowledged_at
           )
           SELECT ?, m.id, NULL
           FROM messages m
           INNER JOIN dispatch_contexts d ON d.id = ?
           WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct' AND m.read = 1
             AND d.status IN ('pending', 'dispatched')
             AND m.created_at >= d.created_at
             AND (m.to_handle = ? OR m.to_handle = ?)`
        )
        .run(
          principal.id,
          principal.dispatch_id,
          principal.run_id,
          principal.terminal_handle,
          `dispatch:${principal.dispatch_id}`
        )
      return
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO legacy_mail_receipts (
           principal_id, message_id, acknowledged_at
         )
         SELECT ?, m.id, NULL
         FROM messages m
         WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct' AND m.read = 1
           AND m.to_handle = ?
           AND EXISTS(
             SELECT 1 FROM dispatch_contexts d
             WHERE d.run_id = m.run_id
               AND d.contract_version = ?
               AND d.status IN ('pending', 'dispatched')
               AND m.created_at >= d.created_at
               AND (m.from_handle = d.assignee_handle OR m.from_handle = 'dispatch:' || d.id)
           )`
      )
      .run(principal.id, principal.run_id, principal.terminal_handle, LEGACY_CONTRACT_VERSION)
  }

  getLegacyMailPage(params: { principalId: string; limit?: number; types?: MessageType[] }): {
    messages: MessageRow[]
    recovery: boolean
  } {
    const principal = this.requireLegacyMailPrincipal(params.principalId)
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 50)
    const addressSql =
      principal.role === 'worker' ? '(m.to_handle = ? OR m.to_handle = ?)' : 'm.to_handle = ?'
    const addressParams =
      principal.role === 'worker'
        ? [principal.terminal_handle, `dispatch:${principal.dispatch_id}`]
        : [principal.terminal_handle]
    const typeSql =
      params.types && params.types.length > 0
        ? `AND m.type IN (${params.types.map(() => '?').join(',')})`
        : ''
    const typeParams = params.types ?? []
    const recovery = this.db
      .prepare(
        `SELECT m.*
         FROM legacy_mail_receipts r
         INNER JOIN messages m ON m.id = r.message_id
         WHERE r.principal_id = ? AND r.acknowledged_at IS NULL
           AND m.run_id = ? AND m.delivery_contract = 'legacy_direct'
           AND ${addressSql}
           ${typeSql}
         ORDER BY m.sequence ASC LIMIT ?`
      )
      .all(
        params.principalId,
        principal.run_id,
        ...addressParams,
        ...typeParams,
        limit
      ) as MessageRow[]
    if (recovery.length > 0) {
      return { messages: exposeMessageListTimestamps(recovery), recovery: true }
    }

    const unread = this.db
      .prepare(
        `SELECT m.*
         FROM messages m
         LEFT JOIN legacy_mail_receipts r
           ON r.principal_id = ? AND r.message_id = m.id
         WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct'
           AND m.read = 0 AND r.message_id IS NULL AND ${addressSql}
           ${typeSql}
         ORDER BY m.sequence ASC LIMIT ?`
      )
      .all(
        params.principalId,
        principal.run_id,
        ...addressParams,
        ...typeParams,
        limit
      ) as MessageRow[]
    return { messages: exposeMessageListTimestamps(unread), recovery: false }
  }

  getLegacyMailHistory(params: { principalId: string; limit?: number; types?: MessageType[] }): {
    messages: MessageRow[]
    recovery: false
  } {
    const principal = this.requireLegacyMailPrincipal(params.principalId)
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 100)
    const addressSql =
      principal.role === 'worker' ? '(to_handle = ? OR to_handle = ?)' : 'to_handle = ?'
    const addressParams =
      principal.role === 'worker'
        ? [principal.terminal_handle, `dispatch:${principal.dispatch_id}`]
        : [principal.terminal_handle]
    const typeSql =
      params.types && params.types.length > 0
        ? `AND type IN (${params.types.map(() => '?').join(',')})`
        : ''
    const messages = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE run_id = ? AND delivery_contract = 'legacy_direct'
           AND ${addressSql} ${typeSql}
         ORDER BY sequence ASC LIMIT ?`
      )
      .all(principal.run_id, ...addressParams, ...(params.types ?? []), limit) as MessageRow[]
    return { messages: exposeMessageListTimestamps(messages), recovery: false }
  }

  acknowledgeLegacyMail(params: {
    principalId: string
    messageIds: string[]
    types?: MessageType[]
  }): {
    receipts: LegacyMailReceiptRow[]
    duplicate: boolean
  } {
    if (params.messageIds.length === 0) {
      return { receipts: [], duplicate: true }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const principal = this.requireLegacyMailPrincipal(params.principalId)
      const uniqueIds = [...new Set(params.messageIds)]
      const placeholders = uniqueIds.map(() => '?').join(',')
      const prior = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM legacy_mail_receipts
           WHERE principal_id = ? AND message_id IN (${placeholders})
             AND acknowledged_at IS NOT NULL`
        )
        .get(params.principalId, ...uniqueIds) as { count: number }
      if (prior.count !== uniqueIds.length) {
        const actionable = this.getLegacyMailPage({
          principalId: params.principalId,
          limit: uniqueIds.length,
          types: params.types
        }).messages
        if (
          actionable.length !== uniqueIds.length ||
          actionable.some((message, index) => message.id !== uniqueIds[index])
        ) {
          throw new OrchestrationError(
            'request_mismatch',
            'Legacy mail acknowledgment does not match the current replay page.'
          )
        }
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE id IN (${placeholders}) AND run_id = ?
             AND delivery_contract = 'legacy_direct'`
        )
        .all(...uniqueIds, principal.run_id) as MessageRow[]
      const validIds = new Set(
        rows
          .filter(
            (message) =>
              message.to_handle === principal.terminal_handle ||
              (principal.role === 'worker' &&
                message.to_handle === `dispatch:${principal.dispatch_id}`)
          )
          .map((message) => message.id)
      )
      if (validIds.size !== uniqueIds.length || uniqueIds.some((id) => !validIds.has(id))) {
        throw new OrchestrationError(
          'request_mismatch',
          'Legacy mail acknowledgment contains a message outside this principal inbox.'
        )
      }

      this.db
        .prepare(
          `UPDATE messages
           SET read = 1, delivered_at = COALESCE(delivered_at, datetime('now'))
           WHERE id IN (${placeholders})`
        )
        .run(...uniqueIds)
      const insert = this.db.prepare(
        `INSERT INTO legacy_mail_receipts (
           principal_id, message_id, acknowledged_at
         ) VALUES (?, ?, datetime('now'))
         ON CONFLICT(principal_id, message_id)
         DO UPDATE SET acknowledged_at = COALESCE(
           legacy_mail_receipts.acknowledged_at, excluded.acknowledged_at
         )`
      )
      for (const messageId of uniqueIds) {
        insert.run(params.principalId, messageId)
      }
      const receipts = this.db
        .prepare(
          `SELECT * FROM legacy_mail_receipts
           WHERE principal_id = ? AND message_id IN (${placeholders})
           ORDER BY message_id`
        )
        .all(params.principalId, ...uniqueIds) as LegacyMailReceiptRow[]
      this.db.exec('COMMIT')
      return { receipts, duplicate: prior.count === uniqueIds.length }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  acknowledgeLegacyQuestionAnswer(params: {
    principalId: string
    questionId: string
    answerMessageId: string
  }): { receipt: LegacyMailReceiptRow; duplicate: boolean } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const principal = this.requireLegacyMailPrincipal(params.principalId, 'worker')
      const question = this.getQuestionRaw(params.questionId)
      const source = this.getMessageById(params.questionId)
      const answer = this.getMessageById(params.answerMessageId)
      const dispatch = principal.dispatch_id
        ? this.getDispatchContextById(principal.dispatch_id)
        : undefined
      const exactLegacyAnswer =
        answer?.delivery_contract === 'legacy_direct' &&
        (answer.to_handle === principal.terminal_handle ||
          answer.to_handle === `dispatch:${principal.dispatch_id}`)
      const adoption = this.getLegacyAdoption()
      const exactTakenOverAnswer =
        adoption?.adopted_run_id === principal.run_id &&
        dispatch?.run_id === principal.run_id &&
        dispatch.contract_version === LEGACY_CONTRACT_VERSION &&
        source?.run_id === principal.run_id &&
        source.from_handle === principal.terminal_handle &&
        source.to_handle === `run:${principal.run_id}` &&
        source.delivery_contract === 'current_delivery' &&
        answer?.run_id === principal.run_id &&
        answer?.delivery_contract === 'current_delivery' &&
        answer.from_handle === `run:${principal.run_id}` &&
        answer.to_handle === `dispatch:${principal.dispatch_id}` &&
        answer.thread_id === question?.message_id
      if (
        !question ||
        !answer ||
        question.run_id !== principal.run_id ||
        question.dispatch_id !== principal.dispatch_id ||
        question.answer_message_id !== params.answerMessageId ||
        (!exactLegacyAnswer && !exactTakenOverAnswer)
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          'Legacy answer acknowledgment does not match this principal question.'
        )
      }
      const existing = this.db
        .prepare(
          `SELECT * FROM legacy_mail_receipts
           WHERE principal_id = ? AND message_id = ?`
        )
        .get(params.principalId, params.answerMessageId) as LegacyMailReceiptRow | undefined
      this.db
        .prepare(
          `UPDATE messages
           SET read = 1, delivered_at = COALESCE(delivered_at, datetime('now'))
           WHERE id = ?`
        )
        .run(params.answerMessageId)
      this.db
        .prepare(
          `INSERT INTO legacy_mail_receipts (
             principal_id, message_id, acknowledged_at
           ) VALUES (?, ?, datetime('now'))
           ON CONFLICT(principal_id, message_id)
           DO UPDATE SET acknowledged_at = COALESCE(
             legacy_mail_receipts.acknowledged_at, excluded.acknowledged_at
           )`
        )
        .run(params.principalId, params.answerMessageId)
      const receipt = this.db
        .prepare(
          `SELECT * FROM legacy_mail_receipts
           WHERE principal_id = ? AND message_id = ?`
        )
        .get(params.principalId, params.answerMessageId) as LegacyMailReceiptRow
      this.db.exec('COMMIT')
      return { receipt, duplicate: Boolean(existing?.acknowledged_at) }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ── Runs ──

  createRun(params: {
    objective: string
    coordinatorHandle: string
    coordinatorPaneKey: string
  }): RunRow {
    const id = generateId('run')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.unbindOtherRunsForPane(params.coordinatorPaneKey)
      this.db
        .prepare(
          `INSERT INTO runs (
             id, objective, coordinator_handle, coordinator_pane_key,
             consumer_generation, legacy
           ) VALUES (?, ?, ?, ?, 1, 0)`
        )
        .run(id, params.objective, params.coordinatorHandle, params.coordinatorPaneKey)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getRun(id) as RunRow
  }

  bindRun(params: {
    runId: string
    coordinatorHandle: string
    coordinatorPaneKey: string
    takeoverLegacy?: boolean
    legacyCoordinatorAuthority?: {
      runId: string
      principalId: string | null
      terminalHandle: string
      paneKey: string
      consumerGeneration: number
    }
  }): RunRow | undefined {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.getRunRaw(params.runId)
      if (!run || run.legacy === 1) {
        this.db.exec('ROLLBACK')
        return undefined
      }
      const sameBinding =
        run.coordinator_pane_key !== null &&
        isEquivalentPaneKey(run.coordinator_pane_key, params.coordinatorPaneKey)
      const adoption = this.getLegacyAdoption()
      const adoptedRun = adoption?.adopted_run_id === params.runId
      const legacyAuthority = params.legacyCoordinatorAuthority
      const legacyPrincipalId = legacyAuthority?.principalId
      const legacyPrincipal = legacyPrincipalId
        ? this.getLegacyCompatibilityPrincipal(legacyPrincipalId)
        : undefined
      const provenLegacyBinding = Boolean(
        adoptedRun &&
        legacyAuthority &&
        legacyAuthority.principalId !== null &&
        legacyAuthority.runId === params.runId &&
        legacyAuthority.consumerGeneration === run.consumer_generation &&
        legacyPrincipal?.run_id === params.runId &&
        legacyPrincipal.role === 'coordinator' &&
        legacyPrincipal.status === 'committed' &&
        legacyPrincipal.terminal_handle === legacyAuthority.terminalHandle &&
        isEquivalentPaneKey(legacyPrincipal.pane_key, legacyAuthority.paneKey) &&
        params.coordinatorHandle === legacyAuthority.terminalHandle &&
        isEquivalentPaneKey(params.coordinatorPaneKey, legacyAuthority.paneKey)
      )
      if (legacyAuthority && !provenLegacyBinding) {
        throw new OrchestrationError(
          'legacy_read_only',
          'This retained legacy coordinator no longer has lifecycle authority. No effects were applied.',
          { effectsApplied: false }
        )
      }
      const activeLegacyAssignment =
        adoptedRun &&
        Boolean(
          this.db
            .prepare(
              `SELECT 1 FROM dispatch_contexts
               WHERE run_id = ? AND contract_version = ?
                 AND status IN ('pending', 'dispatched')
               LIMIT 1`
            )
            .get(params.runId, LEGACY_CONTRACT_VERSION)
        )
      const coordinatorPrincipal = adoptedRun
        ? this.getLegacyCoordinatorPrincipal(params.runId)
        : undefined
      const retainedCoordinatorHandle =
        coordinatorPrincipal?.terminal_handle ??
        run.coordinator_handle ??
        this.getUniqueLegacyCoordinatorHandle(params.runId)
      const takeoverAlreadyApplied = Boolean(
        params.takeoverLegacy &&
        sameBinding &&
        run.coordinator_handle === params.coordinatorHandle &&
        coordinatorPrincipal?.status !== 'committed'
      )
      const replacesLegacyCoordinator = Boolean(
        adoptedRun &&
        !provenLegacyBinding &&
        retainedCoordinatorHandle &&
        (params.takeoverLegacy ||
          retainedCoordinatorHandle !== params.coordinatorHandle ||
          !sameBinding)
      )
      if (params.takeoverLegacy && !adoptedRun) {
        throw new OrchestrationError(
          'invalid_argument',
          'Legacy takeover is only available for the automatically adopted Run.'
        )
      }
      // Why: only LIVE legacy work needs the flag — settled work has no competing authority left, and
      // fencing it would strand the recovered graph behind an attestation the caller may not have.
      if (
        activeLegacyAssignment &&
        !sameBinding &&
        !provenLegacyBinding &&
        !params.takeoverLegacy
      ) {
        throw new OrchestrationError(
          'consumer_fenced',
          'This adopted Run still has live legacy work. Its attested coordinator may rebind it, or a current coordinator may explicitly use run-use --takeover-legacy.',
          {
            effectsApplied: false,
            recoveryCommand: `orca orchestration run-use --id ${params.runId} --takeover-legacy`
          }
        )
      }
      this.unbindOtherRunsForPane(params.coordinatorPaneKey, params.runId)
      if (
        (params.takeoverLegacy && !takeoverAlreadyApplied) ||
        !sameBinding ||
        run.coordinator_handle !== params.coordinatorHandle
      ) {
        if (adoptedRun && (params.takeoverLegacy || !activeLegacyAssignment)) {
          if (
            coordinatorPrincipal?.status === 'committed' &&
            (params.takeoverLegacy ||
              coordinatorPrincipal.terminal_handle !== params.coordinatorHandle ||
              !isEquivalentPaneKey(coordinatorPrincipal.pane_key, params.coordinatorPaneKey))
          ) {
            this.setLegacyCompatibilityPrincipalStatus(coordinatorPrincipal.id, 'revoked')
          }
        }
        this.db
          .prepare(
            `UPDATE runs
             SET coordinator_handle = ?, coordinator_pane_key = ?,
                 consumer_generation = consumer_generation + 1,
                 updated_at = datetime('now')
             WHERE id = ?`
          )
          .run(params.coordinatorHandle, params.coordinatorPaneKey, params.runId)
        this.fenceOutstandingDelivery(params.runId)
        if (params.takeoverLegacy || replacesLegacyCoordinator) {
          this.promoteLegacyCoordinatorMailForTakeover(params.runId, retainedCoordinatorHandle)
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getRun(params.runId)
  }

  getRun(id: string): RunRow | undefined {
    const run = this.getRunRaw(id)
    return run ? exposeRunTimestamps(run) : undefined
  }

  listRuns(params: { limit?: number; cursor?: string } = {}): RunListPage {
    if (params.limit === undefined && params.cursor === undefined) {
      const rows = this.db
        .prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC')
        .all() as RunRow[]
      return { runs: rows.map(exposeRunTimestamps), nextCursor: null }
    }
    const limit = Math.min(
      Math.max(1, params.limit ?? ORCHESTRATION_RUN_PAGE_LIMIT),
      ORCHESTRATION_RUN_PAGE_LIMIT
    )
    const cursor = params.cursor ? decodeRunListCursor(params.cursor) : undefined
    const rows = (
      cursor
        ? this.db
            .prepare(
              `SELECT * FROM runs
             WHERE created_at < ? OR (created_at = ? AND id < ?)
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
            )
            .all(cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
        : this.db
            .prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?')
            .all(limit + 1)
    ) as RunRow[]
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    return {
      runs: pageRows.map(exposeRunTimestamps),
      nextCursor: hasMore ? encodeRunListCursor(pageRows.at(-1) as RunRow) : null
    }
  }

  getCurrentRunForPane(paneKey: string): RunRow | undefined {
    const run = this.runsBoundToPane(paneKey)[0]
    return run ? exposeRunTimestamps(run) : undefined
  }

  // Why: the indexed suffix only narrows candidates; isEquivalentPaneKey still decides, so
  // reminted tab halves keep matching and unparseable keys keep requiring an exact match.
  private runsBoundToPane(paneKey: string): RunRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM runs
           WHERE coordinator_pane_key IS NOT NULL AND legacy = 0
             AND ${RUN_PANE_KEY_MATCH_SUFFIX_SQL} = ?
           ORDER BY rowid`
        )
        .all(paneKeyMatchSuffix(paneKey)) as RunRow[]
    ).filter(
      (run) =>
        run.coordinator_pane_key !== null && isEquivalentPaneKey(run.coordinator_pane_key, paneKey)
    )
  }

  private getRunRaw(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
  }

  private unbindOtherRunsForPane(paneKey: string, exceptRunId?: string): void {
    for (const run of this.runsBoundToPane(paneKey)) {
      if (run.id !== exceptRunId) {
        this.db
          .prepare(
            `UPDATE runs
             SET coordinator_handle = NULL, coordinator_pane_key = NULL,
                 consumer_generation = consumer_generation + 1,
                 updated_at = datetime('now')
             WHERE id = ?`
          )
          .run(run.id)
        this.fenceOutstandingDelivery(run.id)
      }
    }
  }

  private requireRun(runId: string): void {
    if (!this.getRunRaw(runId)) {
      throw new Error(`Run not found: ${runId}`)
    }
  }

  private fenceOutstandingDelivery(runId: string): void {
    this.db
      .prepare(
        "UPDATE deliveries SET status = 'fenced' WHERE run_id = ? AND status = 'outstanding'"
      )
      .run(runId)
  }

  private promoteLegacyCoordinatorMailForTakeover(
    runId: string,
    retainedCoordinatorHandle: string | null
  ): void {
    if (!retainedCoordinatorHandle) {
      return
    }
    this.db
      .prepare(
        `UPDATE messages
         SET to_handle = ?, delivery_contract = 'current_delivery',
             read = 0, delivered_at = NULL
         WHERE run_id = ? AND delivery_contract = 'legacy_direct'
           AND to_handle = ?
           AND EXISTS(
             SELECT 1 FROM dispatch_contexts d
             WHERE d.run_id = messages.run_id
               AND d.contract_version = ?
               AND (
                 messages.from_handle = d.assignee_handle OR
                 messages.from_handle = 'dispatch:' || d.id
               )
           )
           AND (
             read = 0 OR EXISTS(
               SELECT 1 FROM question_threads q
               WHERE q.message_id = messages.id AND q.status = 'pending'
             ) OR EXISTS(
               SELECT 1
               FROM legacy_mail_receipts r
               INNER JOIN legacy_compatibility_principals p
                 ON p.id = r.principal_id
               WHERE r.message_id = messages.id
                 AND r.acknowledged_at IS NULL
                 AND p.run_id = messages.run_id
                 AND p.role = 'coordinator'
                 AND p.terminal_handle = ?
             ) OR (
               read = 1
               AND NOT EXISTS(
                 SELECT 1 FROM legacy_compatibility_principals p
                 WHERE p.run_id = messages.run_id AND p.role = 'coordinator'
               )
               AND EXISTS(
                 SELECT 1 FROM dispatch_contexts d
                 WHERE d.run_id = messages.run_id
                   AND d.contract_version = ?
                   AND d.status IN ('pending', 'dispatched')
                   AND messages.created_at >= d.created_at
                   AND (
                     messages.from_handle = d.assignee_handle OR
                     messages.from_handle = 'dispatch:' || d.id
                   )
               )
             )
           )`
      )
      .run(
        `run:${runId}`,
        runId,
        retainedCoordinatorHandle,
        LEGACY_CONTRACT_VERSION,
        retainedCoordinatorHandle,
        LEGACY_CONTRACT_VERSION
      )
  }

  private getUniqueLegacyCoordinatorHandle(runId: string): string | null {
    const adoption = this.getLegacyAdoption()
    if (!adoption || adoption.adopted_run_id !== runId) {
      return null
    }
    const workerHandles = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT assignee_handle AS handle
             FROM dispatch_contexts
             WHERE run_id = ? AND contract_version = ?
               AND assignee_handle IS NOT NULL
             UNION
             SELECT DISTINCT terminal_handle AS handle
             FROM legacy_compatibility_principals
             WHERE run_id = ? AND role = 'worker'
               AND status IN ('committed', 'settled')`
          )
          .all(runId, LEGACY_CONTRACT_VERSION, runId) as { handle: string }[]
      ).map((row) => row.handle)
    )
    const durableRows = this.db
      .prepare(
        `SELECT coordinator_handle AS handle
         FROM coordinator_runs
         WHERE scheduler_lost_at = ?
         UNION
         SELECT created_by_terminal_handle AS handle
         FROM tasks t
         WHERE t.run_id = ? AND t.created_by_terminal_handle IS NOT NULL
           AND t.created_at <= ?
           AND EXISTS(
             SELECT 1 FROM dispatch_contexts d
             WHERE d.task_id = t.id AND d.run_id = t.run_id
               AND d.contract_version = ?
           )`
      )
      .all(adoption.adopted_at, runId, adoption.adopted_at, LEGACY_CONTRACT_VERSION) as {
      handle: string
    }[]
    if (durableRows.some((row) => workerHandles.has(row.handle))) {
      return null
    }
    const candidates = new Set(durableRows.map((row) => row.handle))
    const mailRows = this.db
      .prepare(
        `SELECT m.to_handle AS handle
         FROM messages m
         INNER JOIN dispatch_contexts d
           ON d.run_id = m.run_id AND d.contract_version = ?
          AND (m.from_handle = d.assignee_handle OR m.from_handle = 'dispatch:' || d.id)
         WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct'
           AND m.created_at <= ?
         UNION
         SELECT m.from_handle AS handle
         FROM messages m
         INNER JOIN dispatch_contexts d
           ON d.run_id = m.run_id AND d.contract_version = ?
          AND (m.to_handle = d.assignee_handle OR m.to_handle = 'dispatch:' || d.id)
         WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct'
           AND m.created_at <= ?`
      )
      .all(
        LEGACY_CONTRACT_VERSION,
        runId,
        adoption.adopted_at,
        LEGACY_CONTRACT_VERSION,
        runId,
        adoption.adopted_at
      ) as {
      handle: string
    }[]
    for (const row of mailRows) {
      if (
        !workerHandles.has(row.handle) &&
        !row.handle.startsWith('dispatch:') &&
        !row.handle.startsWith('run:')
      ) {
        candidates.add(row.handle)
      }
    }
    return candidates.size === 1 ? ([...candidates][0] ?? null) : null
  }

  private requireCurrentConsumer(runId: string, consumerGeneration: number): RunRow {
    const run = this.getRunRaw(runId)
    if (!run || run.legacy === 1 || run.consumer_generation !== consumerGeneration) {
      throw new OrchestrationError(
        'consumer_fenced',
        'This mailbox consumer has been replaced. Rebind with orchestration run-use.'
      )
    }
    return run
  }

  private getDeliveryRaw(id: string): DeliveryRow | undefined {
    return this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as
      | DeliveryRow
      | undefined
  }

  private getDeliveryMessages(delivery: DeliveryRow): MessageRow[] {
    const ids = JSON.parse(delivery.message_ids) as string[]
    if (ids.length === 0) {
      return []
    }
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as MessageRow[]
    const byId = new Map(rows.map((row) => [row.id, row]))
    return exposeMessageListTimestamps(
      ids.map((id) => byId.get(id)).filter((row): row is MessageRow => row !== undefined)
    )
  }

  getOrCreateRunDelivery(params: {
    runId: string
    consumerGeneration: number
    limit?: number
    wakeTypes?: MessageType[]
  }): { delivery: DeliveryRow; messages: MessageRow[]; replayed: boolean } | undefined {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 50)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.requireCurrentConsumer(params.runId, params.consumerGeneration)
      const existing = this.db
        .prepare("SELECT * FROM deliveries WHERE run_id = ? AND status = 'outstanding'")
        .get(params.runId) as DeliveryRow | undefined
      if (existing) {
        if (existing.consumer_generation !== params.consumerGeneration) {
          throw new OrchestrationError(
            'consumer_fenced',
            'This mailbox Delivery belongs to a fenced consumer generation.'
          )
        }
        const messages = this.getDeliveryMessages(existing)
        this.db.exec('COMMIT')
        return { delivery: exposeDeliveryTimestamps(existing), messages, replayed: true }
      }

      const address = `run:${params.runId}`
      if (params.wakeTypes && params.wakeTypes.length > 0) {
        const placeholders = params.wakeTypes.map(() => '?').join(',')
        const matching = this.db
          .prepare(
            `SELECT 1 FROM messages
             WHERE run_id = ? AND to_handle = ? AND read = 0
               AND delivery_contract = 'current_delivery'
               AND type IN (${placeholders}) LIMIT 1`
          )
          .get(params.runId, address, ...params.wakeTypes)
        if (!matching) {
          this.db.exec('COMMIT')
          return undefined
        }
      }

      const messages = exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages
             WHERE run_id = ? AND to_handle = ? AND read = 0
               AND delivery_contract = 'current_delivery'
             ORDER BY sequence ASC LIMIT ?`
          )
          .all(params.runId, address, limit) as MessageRow[]
      )
      if (messages.length === 0) {
        this.db.exec('COMMIT')
        return undefined
      }

      const deliveryId = generateId('delivery')
      this.db
        .prepare(
          `INSERT INTO deliveries (id, run_id, consumer_generation, message_ids)
           VALUES (?, ?, ?, ?)`
        )
        .run(
          deliveryId,
          params.runId,
          params.consumerGeneration,
          JSON.stringify(messages.map((message) => message.id))
        )
      const delivery = this.getDeliveryRaw(deliveryId) as DeliveryRow
      this.db.exec('COMMIT')
      return { delivery: exposeDeliveryTimestamps(delivery), messages, replayed: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  acknowledgeRunDelivery(params: {
    runId: string
    consumerGeneration: number
    deliveryId: string
  }): { delivery: DeliveryRow; duplicate: boolean } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.requireCurrentConsumer(params.runId, params.consumerGeneration)
      const delivery = this.getDeliveryRaw(params.deliveryId)
      if (!delivery || delivery.run_id !== params.runId) {
        throw new OrchestrationError(
          'stale_delivery',
          `Delivery ${params.deliveryId} does not belong to this Run.`
        )
      }
      if (
        delivery.consumer_generation !== params.consumerGeneration ||
        delivery.status === 'fenced'
      ) {
        throw new OrchestrationError(
          'consumer_fenced',
          'This mailbox Delivery belongs to a fenced consumer generation.'
        )
      }
      if (delivery.status === 'acknowledged') {
        this.db.exec('COMMIT')
        return { delivery: exposeDeliveryTimestamps(delivery), duplicate: true }
      }

      const messageIds = JSON.parse(delivery.message_ids) as string[]
      if (messageIds.length > 0) {
        const placeholders = messageIds.map(() => '?').join(',')
        this.db
          .prepare(`UPDATE messages SET read = 1 WHERE id IN (${placeholders})`)
          .run(...messageIds)
      }
      this.db
        .prepare(
          "UPDATE deliveries SET status = 'acknowledged', acknowledged_at = datetime('now') WHERE id = ?"
        )
        .run(delivery.id)
      const acknowledged = this.getDeliveryRaw(delivery.id) as DeliveryRow
      this.db.exec('COMMIT')
      return { delivery: exposeDeliveryTimestamps(acknowledged), duplicate: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getRunMailboxHistory(runId: string, limit = 100, types?: MessageType[]): MessageRow[] {
    const address = `run:${runId}`
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',')
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages WHERE run_id = ? AND to_handle = ?
             AND type IN (${placeholders}) ORDER BY sequence DESC LIMIT ?`
          )
          .all(runId, address, ...types, limit) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages WHERE run_id = ? AND to_handle = ?
           ORDER BY sequence DESC LIMIT ?`
        )
        .all(runId, address, limit) as MessageRow[]
    )
  }

  // ── Messages ──

  insertMessage(msg: {
    id?: string
    from: string
    to: string
    subject: string
    body?: string
    type?: MessageType
    priority?: MessagePriority
    threadId?: string
    payload?: string
    senderPaneKey?: string
    runId?: string
    deliveryContract?: MessageDeliveryContract
  }): MessageRow {
    const runId = msg.runId ?? LEGACY_RUN_ID
    const deliveryContract = msg.deliveryContract ?? 'current_delivery'
    this.requireRun(runId)
    const id = msg.id ?? generateId('msg')
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        id, run_id, delivery_contract, from_handle, to_handle, subject, body,
        type, priority, thread_id, payload, sender_pane_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      runId,
      deliveryContract,
      msg.from,
      msg.to,
      msg.subject,
      msg.body ?? '',
      msg.type ?? 'status',
      msg.priority ?? 'normal',
      msg.threadId ?? null,
      msg.payload ?? null,
      msg.senderPaneKey ?? null
    )
    return exposeMessageTimestamps(
      this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow
    )
  }

  commitLegacyLifecycleOperation(params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
    message: {
      existingId?: string
      to: string
      subject: string
      body?: string
      type: MessageType
      priority?: MessagePriority
      payload?: string
    }
    lifecycle:
      | { kind: 'message_only' }
      | { kind: 'heartbeat'; at: string }
      | {
          kind: 'worker_report'
          taskId: string
          outcome: WorkerReportOutcome
          result: string
        }
  }): {
    receipt: LegacyOperationReceiptRow
    message: MessageRow
    settlement?: WorkerReportSettlement
    duplicate: boolean
  } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const principal = this.getLegacyCompatibilityPrincipal(params.principalId)
      if (
        !principal ||
        principal.role !== 'worker' ||
        !['committed', 'settled'].includes(principal.status)
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Legacy compatibility principal ${params.principalId} cannot send lifecycle work.`
        )
      }
      const dispatchId = principal.dispatch_id as string
      const existingReceipt = this.requireMatchingLegacyOperationReceipt(params)
      if (existingReceipt) {
        const response = JSON.parse(existingReceipt.response_json) as {
          messageId: string
          settlement?: WorkerReportSettlement
        }
        const message = this.getMessageById(response.messageId)
        if (!message) {
          throw new OrchestrationError(
            'operation_unknown',
            `Legacy operation ${params.operationKey} lost its recorded message.`
          )
        }
        this.db.exec('COMMIT')
        return {
          receipt: existingReceipt,
          message,
          settlement: response.settlement,
          duplicate: true
        }
      }

      const dispatch = this.getDispatchContextById(dispatchId)
      if (
        !dispatch ||
        dispatch.run_id !== principal.run_id ||
        dispatch.contract_version !== LEGACY_CONTRACT_VERSION
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} is not this principal's legacy attempt.`
        )
      }
      if (
        (principal.status === 'settled' || !['pending', 'dispatched'].includes(dispatch.status)) &&
        (!params.message.existingId || params.lifecycle.kind !== 'worker_report')
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} is settled and only matching completion reconstruction is allowed.`
        )
      }
      let message = params.message.existingId
        ? this.getMessageById(params.message.existingId)
        : undefined
      const delivery = this.resolveLegacyWorkerCoordinatorDelivery(
        principal.run_id,
        params.message.to
      )
      if (params.message.existingId) {
        const matchesOriginalLegacyRoute =
          message?.delivery_contract === 'legacy_direct' && message.to_handle === params.message.to
        const matchesCurrentRoute =
          message?.delivery_contract === delivery.contract && message.to_handle === delivery.to
        if (
          !message ||
          message.run_id !== principal.run_id ||
          message.from_handle !== principal.terminal_handle ||
          (!matchesOriginalLegacyRoute && !matchesCurrentRoute)
        ) {
          throw new OrchestrationError(
            'request_mismatch',
            `Existing legacy message ${params.message.existingId} does not match this principal.`
          )
        }
      } else {
        message = this.insertMessage({
          from: principal.terminal_handle,
          to: delivery.to,
          subject: params.message.subject,
          body: params.message.body,
          type: params.message.type,
          priority: params.message.priority,
          payload: params.message.payload,
          senderPaneKey: principal.pane_key,
          runId: principal.run_id,
          deliveryContract: delivery.contract
        })
      }

      let settlement: WorkerReportSettlement | undefined
      if (params.lifecycle.kind === 'heartbeat') {
        this.recordHeartbeat(dispatchId, params.lifecycle.at)
      } else if (params.lifecycle.kind === 'worker_report') {
        const persistedOutcome =
          params.message.existingId &&
          dispatch.task_id === params.lifecycle.taskId &&
          dispatch.status === 'completed'
            ? 'succeeded'
            : params.message.existingId &&
                dispatch.task_id === params.lifecycle.taskId &&
                dispatch.status === 'failed'
              ? 'failed'
              : undefined
        settlement = persistedOutcome
          ? { action: 'settled', outcome: persistedOutcome, duplicate: true }
          : this.settleWorkerReportInTransaction({
              taskId: params.lifecycle.taskId,
              dispatchId,
              outcome: params.lifecycle.outcome,
              result: params.lifecycle.result
            })
        if (settlement.action === 'rejected') {
          throw new OrchestrationError(settlement.code, settlement.reason)
        }
        this.db
          .prepare(
            `UPDATE legacy_compatibility_principals
             SET status = 'settled' WHERE id = ? AND status = 'committed'`
          )
          .run(principal.id)
      }
      const responseJson = JSON.stringify({ messageId: message.id, settlement })
      const receipt = this.insertLegacyOperationReceipt({
        principalId: principal.id,
        operationKey: params.operationKey,
        method: params.method,
        payloadHash: params.payloadHash,
        effectId: message.id,
        responseJson
      })
      this.db.exec('COMMIT')
      return { receipt, message, settlement, duplicate: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  commitLegacyAskOperation(params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
    question: string
    options?: string[]
    recipientHandle: string
    existingQuestionId?: string
  }): {
    receipt: LegacyOperationReceiptRow
    question: QuestionRow
    message: MessageRow
    duplicate: boolean
  } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const principal = this.requireCommittedLegacyPrincipal(params.principalId, 'worker')
      const receipt = this.requireMatchingLegacyOperationReceipt(params)
      if (receipt) {
        const response = JSON.parse(receipt.response_json) as { questionId: string }
        const question = this.getQuestion(response.questionId)
        const message = this.getMessageById(response.questionId)
        if (!question || !message) {
          throw new OrchestrationError(
            'operation_unknown',
            `Legacy ask ${params.operationKey} lost its durable question.`
          )
        }
        this.db.exec('COMMIT')
        return { receipt, question, message, duplicate: true }
      }

      const dispatchId = principal.dispatch_id as string
      const dispatch = this.getDispatchContextById(dispatchId)
      if (
        !dispatch ||
        dispatch.run_id !== principal.run_id ||
        dispatch.contract_version !== LEGACY_CONTRACT_VERSION ||
        !['pending', 'dispatched'].includes(dispatch.status)
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} is not an active legacy attempt.`
        )
      }

      const existingQuestionId =
        params.existingQuestionId &&
        !this.db
          .prepare(
            `SELECT 1 FROM legacy_operation_receipts
             WHERE principal_id = ? AND method = 'orchestration.ask' AND effect_id = ?
             LIMIT 1`
          )
          .get(principal.id, params.existingQuestionId)
          ? params.existingQuestionId
          : undefined
      let question: QuestionRow
      let message: MessageRow
      const delivery = this.resolveLegacyWorkerCoordinatorDelivery(
        principal.run_id,
        params.recipientHandle
      )
      if (existingQuestionId) {
        const existingQuestion = this.getQuestion(existingQuestionId)
        const existingMessage = this.getMessageById(existingQuestionId)
        if (
          !existingQuestion ||
          !existingMessage ||
          existingQuestion.run_id !== principal.run_id ||
          existingQuestion.dispatch_id !== dispatchId ||
          existingQuestion.status !== 'pending' ||
          existingMessage.delivery_contract !== delivery.contract ||
          !legacyMessageMatchesQuestion(existingMessage, params.question, params.options ?? [], [
            delivery.to
          ])
        ) {
          throw new OrchestrationError(
            'request_mismatch',
            `Question ${params.existingQuestionId} is not a pending ask for this principal.`
          )
        }
        question = existingQuestion
        message = existingMessage
      } else {
        message = this.insertMessage({
          from: principal.terminal_handle,
          to: delivery.to,
          subject: 'Question',
          body: params.question,
          type: delivery.contract === 'legacy_direct' ? 'decision_gate' : 'question',
          payload: JSON.stringify({
            taskId: dispatch.task_id,
            dispatchId,
            question: params.question,
            options: params.options ?? []
          }),
          senderPaneKey: principal.pane_key,
          runId: principal.run_id,
          deliveryContract: delivery.contract
        })
        this.db
          .prepare('UPDATE messages SET thread_id = ? WHERE id = ?')
          .run(message.id, message.id)
        this.db
          .prepare(
            `INSERT INTO question_threads (
               message_id, run_id, dispatch_id, asker_handle
             ) VALUES (?, ?, ?, ?)`
          )
          .run(message.id, principal.run_id, dispatchId, principal.terminal_handle)
        question = this.getQuestion(message.id) as QuestionRow
        message = this.getMessageById(message.id) as MessageRow
      }

      const committedReceipt = this.insertLegacyOperationReceipt({
        principalId: principal.id,
        operationKey: params.operationKey,
        method: params.method,
        payloadHash: params.payloadHash,
        effectId: question.message_id,
        responseJson: JSON.stringify({ questionId: question.message_id })
      })
      this.db.exec('COMMIT')
      return { receipt: committedReceipt, question, message, duplicate: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  findPendingLegacyQuestions(params: {
    principalId: string
    question: string
    options?: string[]
    recipientHandle: string
  }): { question: QuestionRow; message: MessageRow }[] {
    return this.findLegacyQuestionsBySemanticIdentity(params)
      .filter((row) => row.question.status === 'pending')
      .map(({ question, message }) => ({ question, message }))
  }

  findLegacyQuestionsBySemanticIdentity(params: {
    principalId: string
    question: string
    options?: string[]
    recipientHandle: string
  }): {
    question: QuestionRow
    message: MessageRow
    answerAcknowledged: boolean
    claimedByOperation: boolean
  }[] {
    const principal = this.requireCommittedLegacyPrincipal(params.principalId, 'worker')
    const runAddress = `run:${principal.run_id}`
    const rows = this.db
      .prepare(
        `SELECT q.*, m.id AS source_message_id,
                EXISTS(
                  SELECT 1 FROM legacy_operation_receipts lor
                  WHERE lor.principal_id = ? AND lor.method = 'orchestration.ask'
                    AND lor.effect_id = q.message_id
                ) AS claimed_by_operation
         FROM question_threads q
         INNER JOIN messages m ON m.id = q.message_id
         WHERE q.run_id = ? AND q.dispatch_id = ?
           AND (
             (m.delivery_contract = 'legacy_direct' AND m.to_handle = ?) OR
             (m.delivery_contract = 'current_delivery' AND m.to_handle = ?)
           )
         ORDER BY m.sequence
         LIMIT 501`
      )
      .all(
        principal.id,
        principal.run_id,
        principal.dispatch_id,
        params.recipientHandle,
        runAddress
      ) as (QuestionRow & {
      source_message_id: string
      claimed_by_operation: number
    })[]
    if (rows.length > 500) {
      throw new OrchestrationError(
        'operation_unknown',
        'Legacy ask identity is too ambiguous to reconstruct safely.'
      )
    }
    return rows
      .filter((row) => {
        const message = this.getMessageById(row.source_message_id)
        return Boolean(
          message &&
          legacyMessageMatchesQuestion(message, params.question, params.options ?? [], [
            params.recipientHandle,
            runAddress
          ])
        )
      })
      .map((row) => ({
        question: exposeQuestionTimestamps(row),
        message: this.getMessageById(row.message_id) as MessageRow,
        claimedByOperation: row.claimed_by_operation === 1,
        answerAcknowledged: row.answer_message_id
          ? Boolean(
              this.db
                .prepare(
                  `SELECT 1 FROM legacy_mail_receipts
                   WHERE principal_id = ? AND message_id = ?
                     AND acknowledged_at IS NOT NULL`
                )
                .get(principal.id, row.answer_message_id)
            )
          : false
      }))
  }

  private resolveLegacyWorkerCoordinatorDelivery(
    runId: string,
    retainedCoordinatorHandle: string
  ): { to: string; contract: MessageDeliveryContract } {
    const run = this.getRunRaw(runId)
    const principal = this.getLegacyCoordinatorPrincipal(runId)
    const takenOver = run?.coordinator_handle !== null && principal?.status !== 'committed'
    return takenOver
      ? { to: `run:${runId}`, contract: 'current_delivery' }
      : { to: retainedCoordinatorHandle, contract: 'legacy_direct' }
  }

  commitLegacyReplyOperation(params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
    questionId: string
    body: string
  }): {
    receipt: LegacyOperationReceiptRow
    question: QuestionRow
    message: MessageRow
    duplicate: boolean
  } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const principal = this.requireCommittedLegacyPrincipal(params.principalId, 'coordinator')
      const receipt = this.requireMatchingLegacyOperationReceipt(params)
      if (receipt) {
        const response = JSON.parse(receipt.response_json) as {
          questionId: string
          messageId: string
        }
        const question = this.getQuestion(response.questionId)
        const message = this.getMessageById(response.messageId)
        if (!question || !message) {
          throw new OrchestrationError(
            'operation_unknown',
            `Legacy reply ${params.operationKey} lost its durable effect.`
          )
        }
        this.db.exec('COMMIT')
        return { receipt, question, message, duplicate: true }
      }

      const question = this.getQuestionRaw(params.questionId)
      const sourceMessage = this.getMessageById(params.questionId)
      const dispatch = question ? this.getDispatchContextById(question.dispatch_id) : undefined
      if (
        !question ||
        !sourceMessage ||
        !dispatch ||
        question.run_id !== principal.run_id ||
        sourceMessage.delivery_contract !== 'legacy_direct' ||
        dispatch.run_id !== principal.run_id ||
        dispatch.contract_version !== LEGACY_CONTRACT_VERSION ||
        question.status === 'closed'
      ) {
        throw new OrchestrationError(
          'question_not_found',
          `Question ${params.questionId} is not actionable in the adopted Run.`
        )
      }
      let message: MessageRow
      if (question.status === 'answered') {
        if (question.answer_body !== params.body || !question.answer_message_id) {
          throw new OrchestrationError(
            'answer_conflict',
            `Question ${params.questionId} already has a different answer.`
          )
        }
        message = this.getMessageById(question.answer_message_id) as MessageRow
        if (
          !message ||
          message.run_id !== principal.run_id ||
          message.delivery_contract !== 'legacy_direct'
        ) {
          throw new OrchestrationError(
            'operation_unknown',
            `Question ${params.questionId} lost its recorded answer message.`
          )
        }
      } else {
        message = this.insertMessage({
          from: principal.terminal_handle,
          to: question.asker_handle,
          subject: 'Re: Question',
          body: params.body,
          threadId: question.message_id,
          runId: principal.run_id,
          deliveryContract: 'legacy_direct'
        })
        this.markAsRead([question.message_id])
        this.db
          .prepare(
            `UPDATE question_threads
             SET status = 'answered', answer_message_id = ?, answer_body = ?,
                 answered_at = datetime('now')
             WHERE message_id = ? AND status = 'pending'`
          )
          .run(message.id, params.body, question.message_id)
      }

      const answered = this.getQuestion(params.questionId) as QuestionRow
      const committedReceipt = this.insertLegacyOperationReceipt({
        principalId: principal.id,
        operationKey: params.operationKey,
        method: params.method,
        payloadHash: params.payloadHash,
        effectId: message.id,
        responseJson: JSON.stringify({
          questionId: answered.message_id,
          messageId: message.id
        })
      })
      this.db.exec('COMMIT')
      return {
        receipt: committedReceipt,
        question: answered,
        message,
        duplicate: question.status === 'answered'
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private requireMatchingLegacyOperationReceipt(params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
  }): LegacyOperationReceiptRow | undefined {
    const receipt = this.getLegacyOperationReceipt(params.principalId, params.operationKey)
    if (
      receipt &&
      (receipt.method !== params.method || receipt.payload_hash !== params.payloadHash)
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Legacy operation ${params.operationKey} was already used with different input.`
      )
    }
    return receipt
  }

  private insertLegacyOperationReceipt(params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
    effectId: string
    responseJson: string
  }): LegacyOperationReceiptRow {
    this.db
      .prepare(
        `INSERT INTO legacy_operation_receipts (
           principal_id, operation_key, method, payload_hash, effect_id, response_json
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.principalId,
        params.operationKey,
        params.method,
        params.payloadHash,
        params.effectId,
        params.responseJson
      )
    return this.getLegacyOperationReceipt(
      params.principalId,
      params.operationKey
    ) as LegacyOperationReceiptRow
  }

  getUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',')
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages
             WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
               AND type IN (${placeholders}) ORDER BY sequence`
          )
          .all(toHandle, ...types) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages
           WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
           ORDER BY sequence`
        )
        .all(toHandle) as MessageRow[]
    )
  }

  convertLifecycleMessageToRejection(
    messageId: string,
    code: string,
    reason: string
  ): MessageRow | undefined {
    const message = this.getMessageById(messageId)
    if (!message || (message.type !== 'worker_done' && message.type !== 'heartbeat')) {
      return message
    }

    const originalBody = message.body ? `\n\nOriginal body:\n${message.body}` : ''
    const body = `Orca rejected this ${message.type}: ${reason}${originalBody}`
    const payload = addLifecycleRejectionMarker(message.payload, code, reason)
    // Why: rejected lifecycle signals stay auditable but must not reach read paths as actionable completion/liveness events.
    this.db
      .prepare(
        `UPDATE messages
         SET priority = 'high', subject = ?, body = ?, payload = ?
         WHERE id = ?`
      )
      .run(`Rejected ${message.type}: ${message.subject}`, body, payload, messageId)
    return this.getMessageById(messageId)
  }

  // Why: delivered_at IS NULL filter — push-on-idle delivers each row at most once; read (set only by check) wouldn't prevent replay.
  getUndeliveredUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',')
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages
             WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL
               AND delivery_contract = 'current_delivery'
               AND type IN (${placeholders}) ORDER BY sequence`
          )
          .all(toHandle, ...types) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages
           WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL
             AND delivery_contract = 'current_delivery'
           ORDER BY sequence`
        )
        .all(toHandle) as MessageRow[]
    )
  }

  getAllMessages(toHandle: string, limit = 20): MessageRow[] {
    return exposeMessageListTimestamps(
      this.db
        .prepare('SELECT * FROM messages WHERE to_handle = ? ORDER BY sequence DESC LIMIT ?')
        .all(toHandle, limit) as MessageRow[]
    )
  }

  getMessageById(id: string): MessageRow | undefined {
    const message = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | MessageRow
      | undefined
    return message ? exposeMessageTimestamps(message) : undefined
  }

  markAsRead(ids: string[]): void {
    if (ids.length === 0) {
      return
    }
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`UPDATE messages SET read = 1 WHERE id IN (${placeholders})`).run(...ids)
  }

  // Why: use datetime('now') so delivered_at matches the space-format UTC shape of the table's other timestamps for correct ordering (§3.2).
  markAsDelivered(ids: string[]): void {
    if (ids.length === 0) {
      return
    }
    const placeholders = ids.map(() => '?').join(',')
    this.db
      .prepare(`UPDATE messages SET delivered_at = datetime('now') WHERE id IN (${placeholders})`)
      .run(...ids)
  }

  markAsReadAndDelivered(ids: string[]): void {
    if (ids.length === 0) {
      return
    }
    const placeholders = ids.map(() => '?').join(',')
    // Why: superseded lifecycle messages stay in history but must not be consumed or injected after their dispatch finished.
    this.db
      .prepare(
        `UPDATE messages SET read = 1, delivered_at = COALESCE(delivered_at, datetime('now')) WHERE id IN (${placeholders})`
      )
      .run(...ids)
  }

  getInbox(limit = 20): MessageRow[] {
    return exposeMessageListTimestamps(
      this.db
        .prepare('SELECT * FROM messages ORDER BY sequence DESC LIMIT ?')
        .all(limit) as MessageRow[]
    )
  }

  // Why: read-only history for a handle — returns every message regardless of read/delivered state, never flips the read bit (§3.3).
  getAllMessagesForHandle(toHandle: string, limit = 100, types?: MessageType[]): MessageRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',')
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages WHERE to_handle = ? AND type IN (${placeholders}) ORDER BY sequence DESC LIMIT ?`
          )
          .all(toHandle, ...types, limit) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare('SELECT * FROM messages WHERE to_handle = ? ORDER BY sequence DESC LIMIT ?')
        .all(toHandle, limit) as MessageRow[]
    )
  }

  // Why: ask wait-loop read — to_handle filter shows only replies to the worker; afterSequence resumes past its own outbound ask.
  getThreadMessagesFor(threadId: string, toHandle: string, afterSequence?: number): MessageRow[] {
    if (afterSequence !== undefined) {
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            'SELECT * FROM messages WHERE thread_id = ? AND to_handle = ? AND sequence > ? ORDER BY sequence ASC'
          )
          .all(threadId, toHandle, afterSequence) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          'SELECT * FROM messages WHERE thread_id = ? AND to_handle = ? ORDER BY sequence ASC'
        )
        .all(threadId, toHandle) as MessageRow[]
    )
  }

  createQuestion(params: {
    runId: string
    dispatchId: string
    askerHandle: string
    question: string
    options?: string[]
  }): { question: QuestionRow; message: MessageRow } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.requireRun(params.runId)
      const dispatch = this.getDispatchContextById(params.dispatchId)
      if (
        !dispatch ||
        dispatch.run_id !== params.runId ||
        (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${params.dispatchId} is not active in Run ${params.runId}.`
        )
      }
      const message = this.insertMessage({
        from: `dispatch:${params.dispatchId}`,
        to: `run:${params.runId}`,
        subject: 'Question',
        body: params.question,
        type: 'question',
        payload: JSON.stringify({
          taskId: dispatch.task_id,
          dispatchId: dispatch.id,
          question: params.question,
          options: params.options ?? []
        }),
        runId: params.runId
      })
      this.db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?').run(message.id, message.id)
      this.db
        .prepare(
          `INSERT INTO question_threads (
             message_id, run_id, dispatch_id, asker_handle
           ) VALUES (?, ?, ?, ?)`
        )
        .run(message.id, params.runId, params.dispatchId, params.askerHandle)
      const question = this.getQuestionRaw(message.id) as QuestionRow
      const storedMessage = this.getMessageById(message.id) as MessageRow
      this.db.exec('COMMIT')
      return { question: exposeQuestionTimestamps(question), message: storedMessage }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getQuestion(messageId: string): QuestionRow | undefined {
    const question = this.getQuestionRaw(messageId)
    return question ? exposeQuestionTimestamps(question) : undefined
  }

  private getQuestionRaw(messageId: string): QuestionRow | undefined {
    return this.db.prepare('SELECT * FROM question_threads WHERE message_id = ?').get(messageId) as
      | QuestionRow
      | undefined
  }

  answerQuestion(params: {
    messageId: string
    runId: string
    consumerGeneration: number
    body: string
  }): { question: QuestionRow; message: MessageRow; duplicate: boolean } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.requireCurrentConsumer(params.runId, params.consumerGeneration)
      const question = this.getQuestionRaw(params.messageId)
      if (!question || question.run_id !== params.runId) {
        throw new OrchestrationError(
          'question_not_found',
          `Question ${params.messageId} was not found in Run ${params.runId}.`
        )
      }
      if (question.status === 'closed') {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Question ${params.messageId} is closed because its Dispatch is inactive.`
        )
      }
      if (question.status === 'answered') {
        if (question.answer_body !== params.body || !question.answer_message_id) {
          throw new OrchestrationError(
            'answer_conflict',
            `Question ${params.messageId} already has a different answer.`
          )
        }
        const message = this.getMessageById(question.answer_message_id)
        if (!message) {
          throw new Error(`Recorded answer message ${question.answer_message_id} was not found.`)
        }
        this.db.exec('COMMIT')
        return { question: exposeQuestionTimestamps(question), message, duplicate: true }
      }

      const message = this.insertMessage({
        from: `run:${params.runId}`,
        to: `dispatch:${question.dispatch_id}`,
        subject: 'Re: Question',
        body: params.body,
        threadId: question.message_id,
        runId: params.runId
      })
      // Why: ask returns thread state directly; leaving its answer unread would deliver it again via check.
      this.markAsRead([message.id])
      this.db
        .prepare(
          `UPDATE question_threads
           SET status = 'answered', answer_message_id = ?, answer_body = ?,
               answered_by_generation = ?, answered_at = datetime('now')
           WHERE message_id = ? AND status = 'pending'`
        )
        .run(message.id, params.body, params.consumerGeneration, question.message_id)
      const answered = this.getQuestionRaw(question.message_id) as QuestionRow
      const storedMessage = this.getMessageById(message.id) as MessageRow
      this.db.exec('COMMIT')
      return {
        question: exposeQuestionTimestamps(answered),
        message: storedMessage,
        duplicate: false
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  closeQuestionsForDispatch(dispatchId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT message_id FROM question_threads WHERE dispatch_id = ? AND status = 'pending'"
      )
      .all(dispatchId) as { message_id: string }[]
    if (rows.length === 0) {
      return []
    }
    this.db
      .prepare(
        "UPDATE question_threads SET status = 'closed', closed_at = datetime('now') WHERE dispatch_id = ? AND status = 'pending'"
      )
      .run(dispatchId)
    return rows.map((row) => row.message_id)
  }

  // ── Tasks ──

  createTask(task: {
    spec: string
    taskTitle?: string
    displayName?: string
    deps?: string[]
    parentId?: string
    createdByTerminalHandle?: string
    createdByPaneKey?: string
    createdByProcessIncarnation?: string
    createdByRunGeneration?: number
    runId?: string
  }): TaskRow {
    const runId = task.runId ?? LEGACY_RUN_ID
    this.requireRun(runId)
    if (task.parentId) {
      const parent = this.getTask(task.parentId)
      if (!parent || parent.run_id !== runId) {
        throw new Error(`Parent task ${task.parentId} must belong to run ${runId}`)
      }
    }
    for (const depId of task.deps ?? []) {
      const dependency = this.getTask(depId)
      if (!dependency || dependency.run_id !== runId) {
        throw new Error(`Dependency task ${depId} must belong to run ${runId}`)
      }
    }
    const id = generateId('task')
    const depsJson = JSON.stringify(task.deps ?? [])
    const hasDeps = (task.deps ?? []).length > 0
    const status: TaskStatus = hasDeps ? 'pending' : 'ready'
    const display = buildOrchestrationTaskDisplayMetadata({
      spec: task.spec,
      taskTitle: task.taskTitle,
      displayName: task.displayName
    })
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, run_id, parent_id, created_by_terminal_handle, created_by_pane_key,
           created_by_process_incarnation, created_by_run_generation,
           task_title, display_name, spec, status, deps
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        runId,
        task.parentId ?? null,
        task.createdByTerminalHandle ?? null,
        task.createdByPaneKey ?? null,
        task.createdByProcessIncarnation ?? null,
        task.createdByRunGeneration ?? null,
        display.taskTitle || null,
        display.displayName || null,
        task.spec,
        status,
        depsJson
      )
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow
  }

  // Why: return the active creator Dispatch proof with the Task read; runtime still owns pane/process currency.
  getTask(id: string): TaskRow | undefined
  getTask(id: string, dispatchRunId: string): TaskRuntimeLineageRow | undefined
  getTask(id: string, dispatchRunId?: string): TaskRow | TaskRuntimeLineageRow | undefined {
    if (dispatchRunId === undefined) {
      return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    }
    return this.db
      .prepare(
        `SELECT t.*,
           creator.id AS creator_dispatch_id,
           creator.run_id AS creator_dispatch_run_id,
           creator.assignee_pane_key AS creator_dispatch_pane_key,
           creator.process_incarnation AS creator_dispatch_process_incarnation
         FROM tasks t
         LEFT JOIN dispatch_contexts creator ON creator.rowid = (
           SELECT candidate.rowid
           FROM dispatch_contexts candidate
           WHERE candidate.assignee_handle = t.created_by_terminal_handle
             AND candidate.run_id = ?
             AND candidate.status IN ('pending', 'dispatched')
           ORDER BY candidate.rowid DESC
           LIMIT 1
         )
         WHERE t.id = ?`
      )
      .get(dispatchRunId, id) as TaskRuntimeLineageRow | undefined
  }

  listTasks(filter?: { status?: TaskStatus; ready?: boolean; runId?: string }): TaskRow[] {
    const runWhere = filter?.runId ? 'run_id = ? AND ' : ''
    const runParams: Database.BindValue[] = filter?.runId ? [filter.runId] : []
    if (filter?.ready) {
      return this.db
        .prepare(`SELECT * FROM tasks WHERE ${runWhere}status = 'ready' ORDER BY created_at`)
        .all(...runParams) as TaskRow[]
    }
    if (filter?.status) {
      return this.db
        .prepare(`SELECT * FROM tasks WHERE ${runWhere}status = ? ORDER BY created_at`)
        .all(...runParams, filter.status) as TaskRow[]
    }
    if (filter?.runId) {
      return this.db
        .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at')
        .all(filter.runId) as TaskRow[]
    }
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as TaskRow[]
  }

  // Why: LEFT JOIN keeps non-dispatched tasks (NULL assignee); the MAX(rowid) subquery matches getDispatchContext's most-recent-active-dispatch semantics.
  listTasksWithDispatch(filter?: {
    status?: TaskStatus
    ready?: boolean
    runId?: string
  }): (TaskRow & {
    assignee_handle: string | null
    dispatch_id: string | null
  })[] {
    const whereClauses: string[] = []
    const params: Database.BindValue[] = []
    if (filter?.runId) {
      whereClauses.push('t.run_id = ?')
      params.push(filter.runId)
    }
    if (filter?.ready) {
      whereClauses.push("t.status = 'ready'")
    } else if (filter?.status) {
      whereClauses.push('t.status = ?')
      params.push(filter.status)
    }
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''
    const sql = `
      SELECT
        t.*,
        d.assignee_handle AS assignee_handle,
        d.id              AS dispatch_id
      FROM tasks t
      LEFT JOIN (
        SELECT dc.*
        FROM dispatch_contexts dc
        INNER JOIN (
          SELECT task_id, MAX(rowid) AS max_rowid
          FROM dispatch_contexts
          WHERE status IN ('pending', 'dispatched')
          GROUP BY task_id
        ) latest ON latest.task_id = dc.task_id AND latest.max_rowid = dc.rowid
      ) d ON d.task_id = t.id
      ${where}
      ORDER BY t.created_at
    `
    return this.db.prepare(sql).all(...params) as (TaskRow & {
      assignee_handle: string | null
      dispatch_id: string | null
    })[]
  }

  updateTaskStatus(id: string, status: TaskStatus, result?: string): TaskRow | undefined {
    const completedAt =
      status === 'completed' || status === 'failed' ? new Date().toISOString() : null
    this.db
      .prepare(
        'UPDATE tasks SET status = ?, result = COALESCE(?, result), completed_at = COALESCE(?, completed_at) WHERE id = ?'
      )
      .run(status, result ?? null, completedAt, id)

    if (status === 'completed') {
      this.promoteReadyTasks(id)
      this.completeActiveDispatchForTask(id)
    }

    return this.getTask(id)
  }

  // Why: runs in the status-update transaction, so a completed task never leaves its ready children unpromoted.
  private promoteReadyTasks(completedTaskId: string): void {
    const candidates = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'pending'")
      .all() as TaskRow[]

    for (const task of candidates) {
      const deps: string[] = JSON.parse(task.deps)
      if (!deps.includes(completedTaskId)) {
        continue
      }

      const allDepsCompleted = deps.every((depId) => {
        const dep = this.getTask(depId)
        return dep?.status === 'completed'
      })
      if (allDepsCompleted) {
        this.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      }
    }
  }

  // ── Dispatch Contexts ──

  createStartingWorkerDispatch(params: {
    taskId: string
    startOptions: unknown
    launchTokenHash?: string
    retryOf?: string
    runtimeEpoch?: string
    federation?: {
      environmentId: string
      environmentName: string
      peerFingerprint: string
      protocolVersion: number
    }
    mutationReceipt?: {
      callerFingerprint: string
      requestId: string
      method: string
      payloadHash: string
    }
  }): { dispatch: DispatchContextRow; worker: WorkerDispatchRow } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (params.mutationReceipt) {
        const receipt = params.mutationReceipt
        const existing = this.getMutationReceipt(receipt.callerFingerprint, receipt.requestId)
        if (existing) {
          if (existing.method !== receipt.method || existing.payload_hash !== receipt.payloadHash) {
            throw new OrchestrationError(
              'request_mismatch',
              `Mutation request ${receipt.requestId} was already used with different input.`
            )
          }
          throw new OrchestrationError(
            'operation_unknown',
            `Mutation ${receipt.requestId} already has a durable acceptance record.`
          )
        }
        this.ensureMutationReceiptCapacity()
        this.db
          .prepare(
            `INSERT INTO mutation_receipts (
               caller_fingerprint, request_id, method, payload_hash, state
             ) VALUES (?, ?, ?, ?, 'pending')`
          )
          .run(receipt.callerFingerprint, receipt.requestId, receipt.method, receipt.payloadHash)
      }
      const task = this.getTask(params.taskId)
      if (!task) {
        throw new OrchestrationError('task_not_found', `Task ${params.taskId} was not found.`)
      }
      if (params.retryOf) {
        const prior = this.getDispatchContextById(params.retryOf)
        const priorWorker = this.getWorkerDispatch(params.retryOf)
        const latest = this.getDispatchContext(task.id)
        if (
          !prior ||
          prior.task_id !== task.id ||
          latest?.id !== prior.id ||
          !priorWorker ||
          !['failed', 'stopped', 'abandoned'].includes(priorWorker.state) ||
          !['failed', 'blocked'].includes(task.status)
        ) {
          throw new OrchestrationError(
            'task_not_startable',
            `Task ${task.id} cannot retry from Dispatch ${params.retryOf}.`
          )
        }
      } else if (task.status !== 'ready') {
        throw new OrchestrationError(
          'task_not_startable',
          `Task ${task.id} is ${task.status}; only a ready Task can start.`
        )
      }

      const id = generateId('ctx')
      if (params.mutationReceipt) {
        this.db
          .prepare(
            `UPDATE mutation_receipts
             SET receipt = ?, updated_at = datetime('now')
             WHERE caller_fingerprint = ? AND request_id = ? AND state = 'pending'`
          )
          .run(
            JSON.stringify({ accepted: { dispatchId: id } }),
            params.mutationReceipt.callerFingerprint,
            params.mutationReceipt.requestId
          )
      }
      this.db
        .prepare(
          `INSERT INTO dispatch_contexts (
             id, run_id, task_id, contract_version, launch_token_hash, status, dispatched_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`
        )
        .run(id, task.run_id, task.id, CURRENT_CONTRACT_VERSION, params.launchTokenHash ?? null)
      this.db
        .prepare(
          `INSERT INTO worker_dispatches (
             dispatch_id, runtime_epoch, state, stage, start_options
           ) VALUES (?, ?, 'starting', 'accepted', ?)`
        )
        .run(id, params.runtimeEpoch ?? null, JSON.stringify(params.startOptions))
      if (params.federation) {
        this.db
          .prepare(
            `INSERT INTO federated_dispatches (
               dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version
             ) VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            id,
            params.federation.environmentId,
            params.federation.environmentName,
            params.federation.peerFingerprint,
            params.federation.protocolVersion
          )
      }
      this.db
        .prepare(
          "UPDATE tasks SET status = 'dispatched', result = NULL, completed_at = NULL WHERE id = ?"
        )
        .run(task.id)
      this.db.exec('COMMIT')
      return {
        dispatch: this.getDispatchContextById(id) as DispatchContextRow,
        worker: this.getWorkerDispatch(id) as WorkerDispatchRow
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  recordWorkerStage(params: {
    dispatchId: string
    stage: string
    worktreeId?: string
    terminalHandle?: string
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
    lastError?: string
    state?: WorkerDispatchState
  }): WorkerDispatchRow {
    const current = this.getWorkerDispatch(params.dispatchId)
    if (!current) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Dispatch ${params.dispatchId} was not found.`
      )
    }
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET stage = ?, state = ?, worktree_id = ?, agent_terminal_handle = ?,
             setup_state = ?, effects = ?, residual_resources = ?, last_error = ?,
             updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(
        params.stage,
        params.state ?? current.state,
        params.worktreeId ?? current.worktree_id,
        params.terminalHandle ?? current.agent_terminal_handle,
        params.setupState ?? current.setup_state,
        params.effects ? JSON.stringify(params.effects) : current.effects,
        params.residualResources
          ? JSON.stringify(params.residualResources)
          : current.residual_resources,
        params.lastError ?? current.last_error,
        params.dispatchId
      )
    return this.getWorkerDispatch(params.dispatchId) as WorkerDispatchRow
  }

  updateWorkerSetupEvidence(params: {
    dispatchId: string
    setupState: string
    effects: unknown[]
  }): { worker: WorkerDispatchRow; changed: boolean } {
    const current = this.getWorkerDispatch(params.dispatchId)
    if (!current) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Dispatch ${params.dispatchId} was not found.`
      )
    }
    const effects = JSON.stringify(params.effects)
    if (current.setup_state === params.setupState && current.effects === effects) {
      return { worker: current, changed: false }
    }
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET setup_state = ?, effects = ?, updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(params.setupState, effects, params.dispatchId)
    return {
      worker: this.getWorkerDispatch(params.dispatchId) as WorkerDispatchRow,
      changed: true
    }
  }

  prepareStartingWorkerAuthority(params: {
    dispatchId: string
    handle: string
    paneKey: string
    processIncarnation: string
    launchTokenHash?: string
    worktreeId: string
    effects: unknown[]
    setupState: string
    hostScope?: string | null
    // 'created': this worker-start operation created the agent terminal (including agent-first
    // worktree creation, whose effects receipt says 'reused_agent_terminal'). 'external': an
    // explicit --terminal reuse; ownership transfers only from an exact owned settled resource.
    terminalOwnership?: 'created' | 'external'
  }): string {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    if (
      dispatch.launch_token_hash &&
      params.launchTokenHash &&
      dispatch.launch_token_hash !== params.launchTokenHash
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${params.dispatchId} already has a different launch-token commitment.`
      )
    }
    const capability = `dcap_${randomBytes(32).toString('base64url')}`
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ?,
               capability_hash = ?, launch_token_hash = COALESCE(launch_token_hash, ?),
               capability_revoked_at = NULL
           WHERE id = ? AND status = 'pending'`
        )
        .run(
          params.handle,
          params.paneKey,
          params.processIncarnation,
          hashDispatchCapability(capability),
          params.launchTokenHash ?? null,
          params.dispatchId
        )
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET stage = 'authority_attached', worktree_id = ?, agent_terminal_handle = ?,
               setup_state = ?, effects = ?, residual_resources = ?, updated_at = datetime('now')
           WHERE dispatch_id = ? AND state = 'starting'`
        )
        .run(
          params.worktreeId,
          params.handle,
          params.setupState,
          JSON.stringify(params.effects),
          JSON.stringify(
            params.effects.filter((effect) =>
              Boolean(
                effect &&
                typeof effect === 'object' &&
                ((effect as { action?: string }).action?.startsWith('created') ||
                  (effect as { action?: string }).action === 'reused_agent_terminal')
              )
            )
          ),
          params.dispatchId
        )
      if (params.terminalOwnership && !this.getWorkerTerminalResourceByOwner(params.dispatchId)) {
        if (params.terminalOwnership === 'created') {
          this.createWorkerTerminalResourceStatement({
            dispatchId: params.dispatchId,
            worktreeId: params.worktreeId,
            terminalHandle: params.handle,
            paneKey: params.paneKey,
            processIncarnation: params.processIncarnation,
            hostScope: params.hostScope,
            ownership: 'owned'
          })
        } else {
          const transferable = this.findTransferableWorkerTerminalResource({
            terminalHandle: params.handle,
            paneKey: params.paneKey,
            processIncarnation: params.processIncarnation,
            hostScope: params.hostScope ?? null
          })
          if (transferable) {
            this.transferWorkerTerminalResourceStatement({
              resourceId: transferable.id,
              toDispatchId: params.dispatchId,
              terminalHandle: params.handle,
              paneKey: params.paneKey,
              processIncarnation: params.processIncarnation,
              hostScope: params.hostScope ?? null
            })
          } else {
            this.createWorkerTerminalResourceStatement({
              dispatchId: params.dispatchId,
              worktreeId: params.worktreeId,
              terminalHandle: params.handle,
              paneKey: params.paneKey,
              processIncarnation: params.processIncarnation,
              hostScope: params.hostScope,
              ownership: 'external'
            })
          }
        }
      }
      this.db.exec('COMMIT')
      return capability
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  markWorkerDispatchReady(dispatchId: string, effects?: unknown[]): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const dispatch = this.getDispatchContextById(dispatchId)
      const worker = this.getWorkerDispatch(dispatchId)
      if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
        throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
      }
      this.db
        .prepare("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?")
        .run(dispatchId)
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'ready', stage = 'input_accepted',
               effects = COALESCE(?, effects), updated_at = datetime('now')
           WHERE dispatch_id = ?`
        )
        .run(effects ? JSON.stringify(effects) : null, dispatchId)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  failWorkerStart(dispatchId: string, stage: string, reason: string): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const dispatch = this.getDispatchContextById(dispatchId)
      const worker = this.getWorkerDispatch(dispatchId)
      if (!dispatch || !worker || worker.state !== 'starting') {
        throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
      }
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET status = 'failed', last_failure = ?, completed_at = datetime('now'),
               capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
           WHERE id = ?`
        )
        .run(reason, dispatchId)
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'failed', stage = ?, last_error = ?, updated_at = datetime('now')
           WHERE dispatch_id = ?`
        )
        .run(stage, reason, dispatchId)
      this.db
        .prepare("UPDATE tasks SET status = 'failed', completed_at = datetime('now') WHERE id = ?")
        .run(dispatch.task_id)
      this.closeQuestionsForDispatch(dispatchId)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  markWorkerStartUnknown(dispatchId: string, stage: string, reason: string): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const dispatch = this.getDispatchContextById(dispatchId)
      const worker = this.getWorkerDispatch(dispatchId)
      if (!dispatch || !worker || worker.state !== 'starting') {
        throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'start_unknown', stage = ?, last_error = ?, updated_at = datetime('now')
           WHERE dispatch_id = ?`
        )
        .run(stage, reason, dispatchId)
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
           WHERE id = ?`
        )
        .run(dispatchId)
      this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(dispatch.task_id)
      this.closeQuestionsForDispatch(dispatchId)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  reconcileFederatedWorkerStart(params: {
    dispatchId: string
    state: 'ready' | 'failed' | 'stopped' | 'start_unknown'
    stage: string
    lastError?: string | null
    worktreeId?: string | null
    terminalHandle?: string | null
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
  }): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const dispatch = this.getDispatchContextById(params.dispatchId)
      const worker = this.getWorkerDispatch(params.dispatchId)
      if (!dispatch || !worker) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Federated Dispatch ${params.dispatchId} was not found.`
        )
      }
      if (!['starting', 'start_unknown'].includes(worker.state)) {
        this.db.exec('COMMIT')
        return worker
      }

      if (params.state === 'ready') {
        this.db
          .prepare(
            `UPDATE worker_dispatches
             SET state = 'ready', stage = ?, worktree_id = COALESCE(?, worktree_id),
                 agent_terminal_handle = COALESCE(?, agent_terminal_handle), setup_state = ?,
                 effects = ?, residual_resources = ?, last_error = NULL,
                 updated_at = datetime('now')
             WHERE dispatch_id = ? AND state IN ('starting', 'start_unknown')`
          )
          .run(
            params.stage,
            params.worktreeId ?? null,
            params.terminalHandle ?? null,
            params.setupState ?? worker.setup_state,
            JSON.stringify(params.effects ?? JSON.parse(worker.effects)),
            JSON.stringify(params.residualResources ?? JSON.parse(worker.residual_resources)),
            params.dispatchId
          )
        this.db
          .prepare(
            "UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ? AND status = 'pending'"
          )
          .run(params.dispatchId)
        this.db
          .prepare(
            "UPDATE tasks SET status = 'dispatched', completed_at = NULL WHERE id = ? AND status = 'blocked'"
          )
          .run(dispatch.task_id)
      } else if (params.state === 'start_unknown') {
        this.db
          .prepare(
            `UPDATE worker_dispatches
             SET stage = ?, last_error = ?, updated_at = datetime('now')
             WHERE dispatch_id = ? AND state IN ('starting', 'start_unknown')`
          )
          .run(params.stage, params.lastError ?? worker.last_error, params.dispatchId)
      } else {
        const reason = params.lastError ?? `The worker server reported ${params.state}.`
        this.db
          .prepare(
            `UPDATE worker_dispatches
             SET state = ?, stage = ?, last_error = ?, updated_at = datetime('now')
             WHERE dispatch_id = ? AND state IN ('starting', 'start_unknown')`
          )
          .run(params.state, params.stage, reason, params.dispatchId)
        this.db
          .prepare(
            `UPDATE dispatch_contexts
             SET status = 'failed', last_failure = ?, completed_at = datetime('now'),
                 capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
             WHERE id = ? AND status IN ('pending', 'dispatched')`
          )
          .run(reason, params.dispatchId)
        this.db
          .prepare(
            "UPDATE tasks SET status = 'failed', completed_at = datetime('now') WHERE id = ? AND status IN ('blocked', 'dispatched')"
          )
          .run(dispatch.task_id)
        this.closeQuestionsForDispatch(params.dispatchId)
      }
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(params.dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getWorkerDispatch(dispatchId: string): WorkerDispatchRow | undefined {
    return this.db
      .prepare('SELECT * FROM worker_dispatches WHERE dispatch_id = ?')
      .get(dispatchId) as WorkerDispatchRow | undefined
  }

  listLegacyWorkerTerminalRecoveryRows(): LegacyWorkerTerminalRecoveryRow[] {
    return this.db
      .prepare(
        `SELECT dc.id AS dispatch_id, dc.task_id, dc.status AS dispatch_status,
                dc.contract_version, dc.assignee_handle, dc.assignee_pane_key,
                dc.process_incarnation, wd.state AS worker_state, wd.worktree_id,
                wd.agent_terminal_handle
         FROM dispatch_contexts dc
         INNER JOIN worker_dispatches wd ON wd.dispatch_id = dc.id
         WHERE wd.state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')
         ORDER BY dc.rowid`
      )
      .all() as LegacyWorkerTerminalRecoveryRow[]
  }

  reconcileMissingWorkerTerminal(dispatchId: string, reason: string): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const dispatch = this.getDispatchContextById(dispatchId)
      const worker = this.getWorkerDispatch(dispatchId)
      if (!dispatch || !worker) {
        throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
      }
      if (['succeeded', 'failed', 'stopped', 'abandoned'].includes(worker.state)) {
        this.db.exec('COMMIT')
        return worker
      }

      const activeDispatch = dispatch.status === 'pending' || dispatch.status === 'dispatched'
      const stopWasPending = worker.state === 'stopping' || worker.state === 'stop_unknown'
      if (activeDispatch) {
        const failureCount = dispatch.failure_count + 1
        const dispatchStatus: DispatchStatus = failureCount >= 3 ? 'circuit_broken' : 'failed'
        this.db
          .prepare(
            `UPDATE dispatch_contexts
             SET status = ?, failure_count = ?, last_failure = ?,
                 completed_at = datetime('now'),
                 capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
             WHERE id = ? AND status IN ('pending', 'dispatched')`
          )
          .run(dispatchStatus, failureCount, reason, dispatchId)
        if (!stopWasPending) {
          const taskStatus: TaskStatus = dispatchStatus === 'circuit_broken' ? 'failed' : 'ready'
          this.db
            .prepare(
              `UPDATE tasks
               SET status = ?, completed_at = CASE WHEN ? = 'failed' THEN datetime('now') ELSE NULL END
               WHERE id = ? AND status IN ('dispatched', 'blocked')`
            )
            .run(taskStatus, taskStatus, dispatch.task_id)
        }
        this.closeQuestionsForDispatch(dispatchId)
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = ?, stage = 'terminal_missing', last_error = ?, updated_at = datetime('now')
           WHERE dispatch_id = ?`
        )
        .run(stopWasPending ? 'stopped' : 'abandoned', reason, dispatchId)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getFederatedDispatch(dispatchId: string): FederatedDispatchRow | undefined {
    return this.db
      .prepare('SELECT * FROM federated_dispatches WHERE dispatch_id = ?')
      .get(dispatchId) as FederatedDispatchRow | undefined
  }

  listActiveFederatedDispatches(runId?: string): FederatedDispatchRow[] {
    return this.db
      .prepare(
        `SELECT fd.*
         FROM federated_dispatches fd
         INNER JOIN dispatch_contexts dc ON dc.id = fd.dispatch_id
         INNER JOIN worker_dispatches wd ON wd.dispatch_id = fd.dispatch_id
         WHERE wd.state IN ('starting', 'ready', 'stopping', 'start_unknown', 'stop_unknown')
           AND (? IS NULL OR dc.run_id = ?)
         ORDER BY fd.rowid`
      )
      .all(runId ?? null, runId ?? null) as FederatedDispatchRow[]
  }

  updateFederatedDispatchResources(params: {
    dispatchId: string
    remoteRuntimeEpoch: string
    worktreeId: string
    terminalHandle: string
  }): FederatedDispatchRow {
    this.db
      .prepare(
        `UPDATE federated_dispatches
         SET remote_runtime_epoch = ?, remote_worktree_id = ?, remote_terminal_handle = ?,
             updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(params.remoteRuntimeEpoch, params.worktreeId, params.terminalHandle, params.dispatchId)
    const row = this.getFederatedDispatch(params.dispatchId)
    if (!row) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Federated Dispatch ${params.dispatchId} was not found.`
      )
    }
    return row
  }

  createRemoteDispatchAttachment(params: {
    dispatchId: string
    taskId: string
    homePeerFingerprint: string
    protocolVersion: number
    runtimeEpoch: string
    mutationReceipt: {
      callerFingerprint: string
      requestId: string
      method: string
      payloadHash: string
    }
  }): RemoteDispatchAttachmentRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (params.homePeerFingerprint !== params.mutationReceipt.callerFingerprint) {
        throw new OrchestrationError(
          'resource_server_mismatch',
          'The authenticated Run-home peer does not match the attachment request.'
        )
      }
      const existingReceipt = this.getMutationReceipt(
        params.mutationReceipt.callerFingerprint,
        params.mutationReceipt.requestId
      )
      if (existingReceipt) {
        throw new OrchestrationError(
          existingReceipt.method === params.mutationReceipt.method &&
            existingReceipt.payload_hash === params.mutationReceipt.payloadHash
            ? 'operation_unknown'
            : 'request_mismatch',
          `Remote attachment request ${params.mutationReceipt.requestId} already exists.`
        )
      }
      this.ensureMutationReceiptCapacity()
      this.db
        .prepare(
          `INSERT INTO mutation_receipts (
             caller_fingerprint, request_id, method, payload_hash, state, receipt
           ) VALUES (?, ?, ?, ?, 'pending', ?)`
        )
        .run(
          params.mutationReceipt.callerFingerprint,
          params.mutationReceipt.requestId,
          params.mutationReceipt.method,
          params.mutationReceipt.payloadHash,
          JSON.stringify({ accepted: { dispatchId: params.dispatchId } })
        )
      this.db
        .prepare(
          `INSERT INTO remote_dispatch_attachments (
             dispatch_id, task_id, home_peer_fingerprint, protocol_version, runtime_epoch
           ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          params.dispatchId,
          params.taskId,
          params.homePeerFingerprint,
          params.protocolVersion,
          params.runtimeEpoch
        )
      this.db.exec('COMMIT')
      return this.getRemoteDispatchAttachment(params.dispatchId) as RemoteDispatchAttachmentRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getRemoteDispatchAttachment(dispatchId: string): RemoteDispatchAttachmentRow | undefined {
    return this.db
      .prepare('SELECT * FROM remote_dispatch_attachments WHERE dispatch_id = ?')
      .get(dispatchId) as RemoteDispatchAttachmentRow | undefined
  }

  recordRemoteAttachmentStage(params: {
    dispatchId: string
    stage: string
    state?: WorkerDispatchState
    worktreeId?: string
    terminalHandle?: string
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
    lastError?: string
  }): RemoteDispatchAttachmentRow {
    const current = this.getRemoteDispatchAttachment(params.dispatchId)
    if (!current) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Remote Dispatch ${params.dispatchId} was not found.`
      )
    }
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET stage = ?, state = ?, worktree_id = ?, terminal_handle = ?, setup_state = ?,
             effects = ?, residual_resources = ?, last_error = ?, updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(
        params.stage,
        params.state ?? current.state,
        params.worktreeId ?? current.worktree_id,
        params.terminalHandle ?? current.terminal_handle,
        params.setupState ?? current.setup_state,
        params.effects ? JSON.stringify(params.effects) : current.effects,
        params.residualResources
          ? JSON.stringify(params.residualResources)
          : current.residual_resources,
        params.lastError ?? current.last_error,
        params.dispatchId
      )
    return this.getRemoteDispatchAttachment(params.dispatchId) as RemoteDispatchAttachmentRow
  }

  updateRemoteAttachmentSetupEvidence(params: {
    dispatchId: string
    setupState: string
    effects: unknown[]
  }): { attachment: RemoteDispatchAttachmentRow; changed: boolean } {
    const current = this.getRemoteDispatchAttachment(params.dispatchId)
    if (!current) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Remote Dispatch ${params.dispatchId} was not found.`
      )
    }
    const effects = JSON.stringify(params.effects)
    if (current.setup_state === params.setupState && current.effects === effects) {
      return { attachment: current, changed: false }
    }
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET setup_state = ?, effects = ?, updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(params.setupState, effects, params.dispatchId)
    return {
      attachment: this.getRemoteDispatchAttachment(
        params.dispatchId
      ) as RemoteDispatchAttachmentRow,
      changed: true
    }
  }

  prepareRemoteAttachmentAuthority(params: {
    dispatchId: string
    paneKey: string
    processIncarnation: string
    worktreeId: string
    terminalHandle: string
    setupState: string
    effects: unknown[]
  }): string {
    const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
    if (!attachment || attachment.state !== 'starting') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${params.dispatchId} is not starting.`
      )
    }
    const capability = `dcap_${randomBytes(32).toString('base64url')}`
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET stage = 'authority_attached', capability_hash = ?, pane_key = ?,
             process_incarnation = ?, worktree_id = ?, terminal_handle = ?, setup_state = ?,
             effects = ?, residual_resources = ?, updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'starting'`
      )
      .run(
        hashDispatchCapability(capability),
        params.paneKey,
        params.processIncarnation,
        params.worktreeId,
        params.terminalHandle,
        params.setupState,
        JSON.stringify(params.effects),
        JSON.stringify(
          params.effects.filter((effect) =>
            Boolean(
              effect &&
              typeof effect === 'object' &&
              ((effect as { action?: string }).action?.startsWith('created') ||
                (effect as { action?: string }).action === 'reused_agent_terminal')
            )
          )
        ),
        params.dispatchId
      )
    return capability
  }

  markRemoteAttachmentReady(dispatchId: string, effects?: unknown[]): RemoteDispatchAttachmentRow {
    const result = this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = 'ready', stage = 'input_accepted',
             effects = COALESCE(?, effects), updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'starting'`
      )
      .run(effects ? JSON.stringify(effects) : null, dispatchId)
    if (result.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${dispatchId} is not starting.`
      )
    }
    return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
  }

  failRemoteAttachment(
    dispatchId: string,
    stage: string,
    reason: string,
    unknown: boolean
  ): RemoteDispatchAttachmentRow {
    const state = unknown ? 'start_unknown' : 'failed'
    const result = this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = ?, stage = ?, last_error = ?, capability_hash = NULL,
             updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'starting'`
      )
      .run(state, stage, reason, dispatchId)
    if (result.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${dispatchId} is not starting.`
      )
    }
    return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
  }

  verifyRemoteAttachmentAuthority(params: {
    dispatchId: string
    capability: string | undefined
    paneKey: string | null
    processIncarnation: string | null
  }): boolean {
    const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
    if (
      !attachment?.capability_hash ||
      !params.capability ||
      !attachment.pane_key ||
      !params.paneKey ||
      !isEquivalentPaneKey(attachment.pane_key, params.paneKey) ||
      !attachment.process_incarnation ||
      attachment.process_incarnation !== params.processIncarnation
    ) {
      return false
    }
    const expected = Buffer.from(attachment.capability_hash, 'hex')
    const observed = Buffer.from(hashDispatchCapability(params.capability), 'hex')
    return expected.length === observed.length && timingSafeEqual(expected, observed)
  }

  isRemoteAttachmentProcessCurrent(params: {
    dispatchId: string
    paneKey: string | null
    processIncarnation: string | null
  }): boolean {
    const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
    return Boolean(
      attachment?.pane_key &&
      params.paneKey &&
      isEquivalentPaneKey(attachment.pane_key, params.paneKey) &&
      attachment.process_incarnation &&
      attachment.process_incarnation === params.processIncarnation
    )
  }

  beginRemoteAttachmentStop(dispatchId: string): RemoteDispatchAttachmentRow {
    const attachment = this.getRemoteDispatchAttachment(dispatchId)
    if (!attachment) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Remote Dispatch ${dispatchId} was not found.`
      )
    }
    if (['succeeded', 'failed', 'stopped', 'abandoned'].includes(attachment.state)) {
      return attachment
    }
    if (!['ready', 'start_unknown'].includes(attachment.state)) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${dispatchId} cannot stop from ${attachment.state}.`
      )
    }
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = 'stopping', stage = 'stop_requested', capability_hash = NULL,
             updated_at = datetime('now')
         WHERE dispatch_id = ? AND state IN ('ready', 'start_unknown')`
      )
      .run(dispatchId)
    return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
  }

  settleRemoteAttachmentStop(dispatchId: string): RemoteDispatchAttachmentRow {
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = 'stopped', stage = 'process_stopped', updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'stopping'`
      )
      .run(dispatchId)
    return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
  }

  markRemoteAttachmentStopUnknown(dispatchId: string, reason: string): RemoteDispatchAttachmentRow {
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = 'stop_unknown', stage = 'stop_outcome_unknown', last_error = ?,
             updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'stopping'`
      )
      .run(reason, dispatchId)
    return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
  }

  findActiveRemoteAttachmentForPane(paneKey: string): RemoteDispatchAttachmentRow | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM remote_dispatch_attachments
         WHERE state IN ('starting', 'ready') AND pane_key IS NOT NULL
         ORDER BY rowid DESC`
      )
      .all() as RemoteDispatchAttachmentRow[]
    return rows.find((row) => row.pane_key && isEquivalentPaneKey(row.pane_key, paneKey))
  }

  enqueueFederationRelay(params: {
    dispatchId: string
    direction: FederationRelayDirection
    kind: string
    payload: string
    messageId?: string
    settleRemoteOutcome?: WorkerReportOutcome
    remoteQuestion?: true
  }): FederationRelayItemRow {
    const byteCount = Buffer.byteLength(params.payload, 'utf8')
    const messageId = params.messageId ?? generateId('relay')
    if (byteCount > 64 * 1024) {
      throw new OrchestrationError(
        'relay_quota_exceeded',
        'A federated orchestration message cannot exceed 64 KiB.'
      )
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (params.settleRemoteOutcome) {
        const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
        if (!attachment || attachment.state !== 'ready') {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Remote Dispatch ${params.dispatchId} is not active.`
          )
        }
      }
      if (params.kind === 'heartbeat') {
        const heartbeat = this.db
          .prepare(
            `SELECT * FROM federation_relay_items
             WHERE dispatch_id = ? AND direction = ? AND kind = 'heartbeat'
               AND acked_at IS NULL
             ORDER BY sequence DESC LIMIT 1`
          )
          .get(params.dispatchId, params.direction) as FederationRelayItemRow | undefined
        if (heartbeat) {
          this.db
            .prepare(
              `UPDATE federation_relay_items
               SET payload = ?, byte_count = ?, created_at = datetime('now')
               WHERE dispatch_id = ? AND direction = ? AND sequence = ?`
            )
            .run(params.payload, byteCount, params.dispatchId, params.direction, heartbeat.sequence)
          this.db.exec('COMMIT')
          return this.getFederationRelayItem(
            params.dispatchId,
            params.direction,
            heartbeat.sequence
          ) as FederationRelayItemRow
        }
      }
      const quota = this.db
        .prepare(
          `SELECT COUNT(*) AS count, COALESCE(SUM(byte_count), 0) AS bytes
           FROM federation_relay_items
           WHERE dispatch_id = ? AND direction = ? AND acked_at IS NULL`
        )
        .get(params.dispatchId, params.direction) as { count: number; bytes: number }
      if (quota.count >= 256 || quota.bytes + byteCount > 1024 * 1024) {
        if (params.kind === 'worker_done') {
          const heartbeat = this.db
            .prepare(
              `SELECT * FROM federation_relay_items
               WHERE dispatch_id = ? AND direction = ? AND kind = 'heartbeat'
                 AND acked_at IS NULL
               ORDER BY sequence LIMIT 1`
            )
            .get(params.dispatchId, params.direction) as FederationRelayItemRow | undefined
          if (heartbeat) {
            this.db
              .prepare(
                `UPDATE federation_relay_items
                 SET message_id = ?, kind = ?, payload = ?, byte_count = ?,
                     created_at = datetime('now')
                 WHERE dispatch_id = ? AND direction = ? AND sequence = ?`
              )
              .run(
                messageId,
                params.kind,
                params.payload,
                byteCount,
                params.dispatchId,
                params.direction,
                heartbeat.sequence
              )
            this.settleRemoteAttachmentInRelayTransaction(
              params.dispatchId,
              params.settleRemoteOutcome
            )
            this.db.exec('COMMIT')
            return this.getFederationRelayItem(
              params.dispatchId,
              params.direction,
              heartbeat.sequence
            ) as FederationRelayItemRow
          }
        }
        throw new OrchestrationError(
          'relay_quota_exceeded',
          `Federated Dispatch ${params.dispatchId} has no relay capacity.`
        )
      }
      const latest = this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) AS sequence
           FROM federation_relay_items WHERE dispatch_id = ? AND direction = ?`
        )
        .get(params.dispatchId, params.direction) as { sequence: number }
      const sequence = latest.sequence + 1
      this.db
        .prepare(
          `INSERT INTO federation_relay_items (
             dispatch_id, direction, sequence, message_id, kind, payload, byte_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.dispatchId,
          params.direction,
          sequence,
          messageId,
          params.kind,
          params.payload,
          byteCount
        )
      if (params.remoteQuestion) {
        this.db
          .prepare(
            `INSERT INTO remote_questions (message_id, dispatch_id)
             VALUES (?, ?)`
          )
          .run(messageId, params.dispatchId)
      }
      this.settleRemoteAttachmentInRelayTransaction(params.dispatchId, params.settleRemoteOutcome)
      this.db.exec('COMMIT')
      return this.getFederationRelayItem(
        params.dispatchId,
        params.direction,
        sequence
      ) as FederationRelayItemRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listFederationRelay(params: {
    dispatchId: string
    direction: FederationRelayDirection
    afterSequence: number
    limit?: number
  }): FederationRelayItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM federation_relay_items
         WHERE dispatch_id = ? AND direction = ? AND sequence > ?
         ORDER BY sequence LIMIT ?`
      )
      .all(
        params.dispatchId,
        params.direction,
        params.afterSequence,
        Math.min(Math.max(params.limit ?? 50, 1), 50)
      ) as FederationRelayItemRow[]
  }

  listPendingFederationRelay(
    dispatchId: string,
    direction: FederationRelayDirection,
    limit = 50
  ): FederationRelayItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM federation_relay_items
         WHERE dispatch_id = ? AND direction = ? AND acked_at IS NULL
         ORDER BY sequence LIMIT ?`
      )
      .all(dispatchId, direction, Math.min(Math.max(limit, 1), 50)) as FederationRelayItemRow[]
  }

  acknowledgeFederationRelay(params: {
    dispatchId: string
    direction: FederationRelayDirection
    throughSequence: number
  }): void {
    this.db
      .prepare(
        `UPDATE federation_relay_items SET acked_at = COALESCE(acked_at, datetime('now'))
         WHERE dispatch_id = ? AND direction = ? AND sequence <= ?`
      )
      .run(params.dispatchId, params.direction, params.throughSequence)
  }

  setFederatedHomeImportSequence(dispatchId: string, sequence: number): void {
    this.db
      .prepare(
        `UPDATE federated_dispatches
         SET to_home_imported_sequence = ?, updated_at = datetime('now')
         WHERE dispatch_id = ? AND to_home_imported_sequence < ?`
      )
      .run(sequence, dispatchId, sequence)
  }

  importFederatedRelayItem(params: {
    dispatchId: string
    sequence: number
    message: {
      id: string
      runId: string
      from: string
      to: string
      subject: string
      body: string
      type: MessageType
      priority: MessagePriority
      threadId?: string
      payload?: string
    }
    lifecycle:
      | { kind: 'none' }
      | { kind: 'heartbeat'; at: string }
      | {
          kind: 'worker_report'
          taskId: string
          outcome: WorkerReportOutcome
          result: string
        }
      | { kind: 'rejected'; code: string; reason: string }
  }): { message: MessageRow; duplicate: boolean } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const federated = this.getFederatedDispatch(params.dispatchId)
      if (!federated) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Federated Dispatch ${params.dispatchId} was not found.`
        )
      }
      if (params.sequence <= federated.to_home_imported_sequence) {
        const existing = this.getMessageById(params.message.id)
        if (!existing) {
          throw new OrchestrationError(
            'operation_unknown',
            `Federated relay sequence ${params.sequence} was committed without its message.`
          )
        }
        this.db.exec('COMMIT')
        return { message: existing, duplicate: true }
      }
      if (params.sequence !== federated.to_home_imported_sequence + 1) {
        throw new OrchestrationError(
          'operation_unknown',
          `Federated relay for ${params.dispatchId} is not contiguous after sequence ${federated.to_home_imported_sequence}.`
        )
      }

      let message = this.getMessageById(params.message.id)
      if (!message) {
        message = this.insertMessage(params.message)
      } else if (
        message.run_id !== params.message.runId ||
        message.to_handle !== params.message.to ||
        message.type !== params.message.type
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Federated relay message ${params.message.id} conflicts with an existing message.`
        )
      }
      if (message.type === 'question') {
        this.registerFederatedQuestion({
          messageId: message.id,
          runId: params.message.runId,
          dispatchId: params.dispatchId
        })
      }
      if (params.lifecycle.kind === 'heartbeat') {
        this.recordHeartbeat(params.dispatchId, params.lifecycle.at)
      } else if (params.lifecycle.kind === 'worker_report') {
        const settlement = this.settleWorkerReportInTransaction({
          taskId: params.lifecycle.taskId,
          dispatchId: params.dispatchId,
          outcome: params.lifecycle.outcome,
          result: params.lifecycle.result
        })
        if (settlement.action === 'rejected') {
          message = this.convertLifecycleMessageToRejection(
            message.id,
            settlement.code,
            settlement.reason
          ) as MessageRow
        }
      } else if (params.lifecycle.kind === 'rejected') {
        message = this.convertLifecycleMessageToRejection(
          message.id,
          params.lifecycle.code,
          params.lifecycle.reason
        ) as MessageRow
      }
      this.setFederatedHomeImportSequence(params.dispatchId, params.sequence)
      this.db.exec('COMMIT')
      return { message, duplicate: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getRemoteQuestion(messageId: string):
    | {
        message_id: string
        dispatch_id: string
        status: 'pending' | 'answered' | 'closed'
        answer_message_id: string | null
        answer_body: string | null
      }
    | undefined {
    return this.db.prepare('SELECT * FROM remote_questions WHERE message_id = ?').get(messageId) as
      | {
          message_id: string
          dispatch_id: string
          status: 'pending' | 'answered' | 'closed'
          answer_message_id: string | null
          answer_body: string | null
        }
      | undefined
  }

  answerRemoteQuestion(params: {
    messageId: string
    dispatchId: string
    answerMessageId: string
    body: string
  }): void {
    const question = this.getRemoteQuestion(params.messageId)
    if (!question || question.dispatch_id !== params.dispatchId) {
      throw new OrchestrationError(
        'question_not_found',
        `Remote Question ${params.messageId} was not found.`
      )
    }
    if (question.status === 'answered') {
      if (
        question.answer_message_id !== params.answerMessageId ||
        question.answer_body !== params.body
      ) {
        throw new OrchestrationError(
          'answer_conflict',
          `Remote Question ${params.messageId} already has a different answer.`
        )
      }
      return
    }
    this.db
      .prepare(
        `UPDATE remote_questions
         SET status = 'answered', answer_message_id = ?, answer_body = ?,
             answered_at = datetime('now')
         WHERE message_id = ? AND status = 'pending'`
      )
      .run(params.answerMessageId, params.body, params.messageId)
  }

  setRemoteWorkerImportSequence(dispatchId: string, sequence: number): void {
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET to_worker_imported_sequence = ?, updated_at = datetime('now')
         WHERE dispatch_id = ? AND to_worker_imported_sequence < ?`
      )
      .run(sequence, dispatchId, sequence)
  }

  registerFederatedQuestion(params: {
    messageId: string
    runId: string
    dispatchId: string
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO question_threads (
           message_id, run_id, dispatch_id, asker_handle
         ) VALUES (?, ?, ?, ?)`
      )
      .run(params.messageId, params.runId, params.dispatchId, `dispatch:${params.dispatchId}`)
  }

  private getFederationRelayItem(
    dispatchId: string,
    direction: FederationRelayDirection,
    sequence: number
  ): FederationRelayItemRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM federation_relay_items
         WHERE dispatch_id = ? AND direction = ? AND sequence = ?`
      )
      .get(dispatchId, direction, sequence) as FederationRelayItemRow | undefined
  }

  private settleRemoteAttachmentInRelayTransaction(
    dispatchId: string,
    outcome: WorkerReportOutcome | undefined
  ): void {
    if (!outcome) {
      return
    }
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = ?, stage = 'worker_report_queued', capability_hash = NULL,
             updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'ready'`
      )
      .run(outcome === 'succeeded' ? 'succeeded' : 'failed', dispatchId)
  }

  isDispatchProcessCurrent(params: {
    dispatchId: string
    paneKey: string | null
    processIncarnation: string | null
  }): boolean {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    return Boolean(
      dispatch?.assignee_pane_key &&
      params.paneKey &&
      isEquivalentPaneKey(dispatch.assignee_pane_key, params.paneKey) &&
      dispatch.process_incarnation &&
      params.processIncarnation === dispatch.process_incarnation
    )
  }

  beginWorkerStop(
    dispatchId: string
  ):
    | { disposition: 'stopping'; worker: WorkerDispatchRow; dispatch: DispatchContextRow }
    | { disposition: 'already_settled'; worker: WorkerDispatchRow; dispatch: DispatchContextRow } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const dispatch = this.getDispatchContextById(dispatchId)
      const worker = this.getWorkerDispatch(dispatchId)
      if (!dispatch || !worker) {
        throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
      }
      if (['succeeded', 'failed', 'stopped', 'abandoned'].includes(worker.state)) {
        this.db.exec('COMMIT')
        return { disposition: 'already_settled', worker, dispatch }
      }
      if (!['ready', 'start_unknown'].includes(worker.state)) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} cannot stop from ${worker.state}.`
        )
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'stopping', stage = 'stop_requested', updated_at = datetime('now')
           WHERE dispatch_id = ? AND state IN ('ready', 'start_unknown')`
        )
        .run(dispatchId)
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
           WHERE id = ?`
        )
        .run(dispatchId)
      this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(dispatch.task_id)
      this.closeQuestionsForDispatch(dispatchId)
      this.db.exec('COMMIT')
      return {
        disposition: 'stopping',
        worker: this.getWorkerDispatch(dispatchId) as WorkerDispatchRow,
        dispatch: this.getDispatchContextById(dispatchId) as DispatchContextRow
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  settleWorkerStop(dispatchId: string): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const worker = this.getWorkerDispatch(dispatchId)
      const dispatch = this.getDispatchContextById(dispatchId)
      if (!worker || !dispatch || worker.state !== 'stopping') {
        throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not stopping.`)
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'stopped', stage = 'process_stopped', updated_at = datetime('now')
           WHERE dispatch_id = ? AND state = 'stopping'`
        )
        .run(dispatchId)
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET status = 'failed', completed_at = datetime('now'), last_failure = 'stopped'
           WHERE id = ? AND status IN ('pending', 'dispatched')`
        )
        .run(dispatchId)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  reconcileFederatedWorkerStop(dispatchId: string): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const worker = this.getWorkerDispatch(dispatchId)
      const dispatch = this.getDispatchContextById(dispatchId)
      if (!worker || !dispatch || !this.getFederatedDispatch(dispatchId)) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Federated Dispatch ${dispatchId} was not found.`
        )
      }
      if (worker.state === 'stopped') {
        this.db.exec('COMMIT')
        return worker
      }
      if (!['stopping', 'stop_unknown'].includes(worker.state)) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Federated Dispatch ${dispatchId} cannot reconcile stop from ${worker.state}.`
        )
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'stopped', stage = 'process_stopped', last_error = NULL,
               updated_at = datetime('now')
           WHERE dispatch_id = ? AND state IN ('stopping', 'stop_unknown')`
        )
        .run(dispatchId)
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET status = 'failed', completed_at = COALESCE(completed_at, datetime('now')),
               last_failure = 'stopped'
           WHERE id = ? AND status IN ('pending', 'dispatched')`
        )
        .run(dispatchId)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  resumeFederatedWorkerForTerminalRelay(dispatchId: string): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const worker = this.getWorkerDispatch(dispatchId)
      const dispatch = this.getDispatchContextById(dispatchId)
      if (!worker || !dispatch || worker.state !== 'stopping') {
        throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not stopping.`)
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'ready', stage = 'remote_report_pending', updated_at = datetime('now')
           WHERE dispatch_id = ? AND state = 'stopping'`
        )
        .run(dispatchId)
      this.db
        .prepare("UPDATE tasks SET status = 'dispatched' WHERE id = ? AND status = 'blocked'")
        .run(dispatch.task_id)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  markWorkerStopUnknown(dispatchId: string, reason: string): WorkerDispatchRow {
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'stop_unknown', stage = 'stop_outcome_unknown', last_error = ?,
             updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'stopping'`
      )
      .run(reason, dispatchId)
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  }

  abandonWorkerDispatch(dispatchId: string): {
    disposition: 'abandoned' | 'already_abandoned' | 'stale'
    worker: WorkerDispatchRow
  } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const worker = this.getWorkerDispatch(dispatchId)
      const dispatch = this.getDispatchContextById(dispatchId)
      if (!worker || !dispatch) {
        throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
      }
      if (worker.state === 'abandoned') {
        this.db.exec('COMMIT')
        return { disposition: 'already_abandoned', worker }
      }
      if (this.getDispatchContext(dispatch.task_id)?.id !== dispatchId) {
        this.db.exec('COMMIT')
        return { disposition: 'stale', worker }
      }
      if (worker.state === 'succeeded') {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} already succeeded and cannot be abandoned.`
        )
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'abandoned', stage = 'abandoned', updated_at = datetime('now')
           WHERE dispatch_id = ?`
        )
        .run(dispatchId)
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET status = CASE WHEN status IN ('pending', 'dispatched') THEN 'failed' ELSE status END,
               capability_revoked_at = COALESCE(capability_revoked_at, datetime('now')),
               completed_at = COALESCE(completed_at, datetime('now'))
           WHERE id = ?`
        )
        .run(dispatchId)
      this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(dispatch.task_id)
      this.closeQuestionsForDispatch(dispatchId)
      this.db.exec('COMMIT')
      return {
        disposition: 'abandoned',
        worker: this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // --- Worker terminal resources (schema v23) ---------------------------------------------------

  // Historical renderer input and reuse cannot be proven, so pre-v23 terminals stay external.
  private backfillWorkerTerminalResources(): void {
    const rows = this.db
      .prepare(
        `SELECT w.dispatch_id, w.worktree_id, w.agent_terminal_handle,
                d.assignee_pane_key, d.process_incarnation
           FROM worker_dispatches w
           JOIN dispatch_contexts d ON d.id = w.dispatch_id
          WHERE w.agent_terminal_handle IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM federated_dispatches f WHERE f.dispatch_id = w.dispatch_id)
            AND NOT EXISTS (
              SELECT 1 FROM worker_terminal_resources r WHERE r.owner_dispatch_id = w.dispatch_id
            )`
      )
      .all() as {
      dispatch_id: string
      worktree_id: string | null
      agent_terminal_handle: string
      assignee_pane_key: string | null
      process_incarnation: string | null
    }[]
    const insert = this.db.prepare(
      `INSERT INTO worker_terminal_resources (
         id, origin_dispatch_id, owner_dispatch_id, worktree_id, terminal_handle,
         pane_key, process_incarnation, ownership_state, release_state, retained_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const row of rows) {
      insert.run(
        generateId('wtr'),
        row.dispatch_id,
        row.dispatch_id,
        row.worktree_id,
        row.agent_terminal_handle,
        row.assignee_pane_key,
        row.process_incarnation,
        'external',
        'retained',
        'legacy_ambiguous'
      )
    }
  }

  // No transaction: composes inside worker-start's authority transaction.
  createWorkerTerminalResourceStatement(params: {
    dispatchId: string
    worktreeId: string | null
    terminalHandle: string
    paneKey: string | null
    processIncarnation: string | null
    hostScope?: string | null
    ownership: Extract<WorkerTerminalOwnershipState, 'owned' | 'external'>
  }): WorkerTerminalResourceRow {
    const id = generateId('wtr')
    this.db
      .prepare(
        `INSERT INTO worker_terminal_resources (
           id, origin_dispatch_id, owner_dispatch_id, worktree_id, terminal_handle,
           pane_key, process_incarnation, host_scope, ownership_state, release_state,
           retained_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_requested', ?)`
      )
      .run(
        id,
        params.dispatchId,
        params.dispatchId,
        params.worktreeId,
        params.terminalHandle,
        params.paneKey,
        params.processIncarnation,
        params.hostScope ?? null,
        params.ownership,
        params.ownership === 'external' ? 'external_terminal' : null
      )
    return this.getWorkerTerminalResource(id) as WorkerTerminalResourceRow
  }

  getWorkerTerminalResource(id: string): WorkerTerminalResourceRow | undefined {
    return this.db.prepare('SELECT * FROM worker_terminal_resources WHERE id = ?').get(id) as
      | WorkerTerminalResourceRow
      | undefined
  }

  getWorkerTerminalResourceByOwner(dispatchId: string): WorkerTerminalResourceRow | undefined {
    return this.db
      .prepare('SELECT * FROM worker_terminal_resources WHERE owner_dispatch_id = ?')
      .get(dispatchId) as WorkerTerminalResourceRow | undefined
  }

  getWorkerTerminalResourceFormerlyOwnedBy(
    dispatchId: string
  ): WorkerTerminalResourceRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM worker_terminal_resources
          WHERE prior_owner_dispatch_ids LIKE ?
          ORDER BY updated_at DESC LIMIT 1`
      )
      .get(`%"${dispatchId}"%`) as WorkerTerminalResourceRow | undefined
  }

  // Reusable exact settled terminal: transfers cleanup ownership to the new Dispatch and fences
  // release through the old owner. No transaction: composes inside the authority transaction.
  transferWorkerTerminalResourceStatement(params: {
    resourceId: string
    toDispatchId: string
    terminalHandle: string
    paneKey: string
    processIncarnation: string
    hostScope: string | null
  }): WorkerTerminalResourceRow {
    const resource = this.getWorkerTerminalResource(params.resourceId)
    if (!resource) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Worker terminal resource ${params.resourceId} was not found.`
      )
    }
    const priorOwners = JSON.parse(resource.prior_owner_dispatch_ids) as string[]
    priorOwners.push(resource.owner_dispatch_id)
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET owner_dispatch_id = ?, prior_owner_dispatch_ids = ?, release_state = 'not_requested',
             retained_reason = NULL, release_requested_at = NULL, release_completed_at = NULL,
             release_error = NULL, terminal_handle = ?, pane_key = ?, process_incarnation = ?,
             host_scope = ?, updated_at = datetime('now')
         WHERE id = ? AND ownership_state = 'owned'`
      )
      .run(
        params.toDispatchId,
        JSON.stringify(priorOwners),
        params.terminalHandle,
        params.paneKey,
        params.processIncarnation,
        params.hostScope,
        params.resourceId
      )
    return this.getWorkerTerminalResource(params.resourceId) as WorkerTerminalResourceRow
  }

  // Finds an owned, settled, exact-match resource for an explicitly reused terminal.
  findTransferableWorkerTerminalResource(params: {
    terminalHandle: string
    paneKey: string | null
    processIncarnation: string | null
    hostScope: string | null
  }): WorkerTerminalResourceRow | undefined {
    if (!params.paneKey || !params.processIncarnation) {
      return undefined
    }
    const candidates = this.db
      .prepare(
        `SELECT r.* FROM worker_terminal_resources r
           JOIN worker_dispatches w ON w.dispatch_id = r.owner_dispatch_id
          WHERE r.process_incarnation = ? AND r.host_scope IS ?
            AND r.ownership_state != 'released'`
      )
      .all(params.processIncarnation, params.hostScope) as WorkerTerminalResourceRow[]
    const exact = candidates.filter(
      (candidate) =>
        candidate.pane_key &&
        params.paneKey &&
        isEquivalentPaneKey(candidate.pane_key, params.paneKey) &&
        candidate.process_incarnation === params.processIncarnation &&
        candidate.host_scope === params.hostScope
    )
    if (
      exact.some((candidate) =>
        ['requested', 'releasing', 'unknown'].includes(candidate.release_state)
      )
    ) {
      throw new OrchestrationError(
        'terminal_release_in_progress',
        `Terminal ${params.terminalHandle} has a release in progress; wait for cleanup or use another terminal.`
      )
    }
    return exact.find(
      (candidate) =>
        candidate.ownership_state === 'owned' &&
        ['not_requested', 'retained'].includes(candidate.release_state) &&
        ['succeeded', 'failed', 'stopped', 'abandoned'].includes(
          this.getWorkerDispatch(candidate.owner_dispatch_id)?.state ?? ''
        )
    )
  }

  workerTerminalResourceHasIdentityConflict(resourceId: string): boolean {
    const resource = this.getWorkerTerminalResource(resourceId)
    if (!resource?.pane_key || !resource.process_incarnation) {
      return true
    }
    const candidates = this.db
      .prepare(
        `SELECT * FROM worker_terminal_resources
          WHERE process_incarnation = ? AND host_scope IS ?
            AND id != ? AND ownership_state != 'released'`
      )
      .all(
        resource.process_incarnation,
        resource.host_scope,
        resource.id
      ) as WorkerTerminalResourceRow[]
    return candidates.some(
      (candidate) =>
        candidate.pane_key &&
        isEquivalentPaneKey(candidate.pane_key, resource.pane_key as string) &&
        candidate.process_incarnation === resource.process_incarnation &&
        candidate.host_scope === resource.host_scope
    )
  }

  requestWorkerTerminalRelease(dispatchId: string):
    | { disposition: 'requested'; resource: WorkerTerminalResourceRow }
    | { disposition: 'already_released'; resource: WorkerTerminalResourceRow }
    | {
        disposition: 'retained'
        resource: WorkerTerminalResourceRow | null
        reason: WorkerTerminalRetainedReason
      } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const worker = this.getWorkerDispatch(dispatchId)
      if (!worker) {
        throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
      }
      if (!['succeeded', 'failed'].includes(worker.state)) {
        // Why: release is post-completion cleanup only; recording intent for an unsettled or
        // uncertain worker would let recovery close a terminal the coordinator never reviewed.
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} is ${worker.state}; only a succeeded or failed worker can release. Use worker-stop to cancel an active worker.`
        )
      }
      const resource = this.getWorkerTerminalResourceByOwner(dispatchId)
      if (!resource) {
        const transferred = this.getWorkerTerminalResourceFormerlyOwnedBy(dispatchId)
        this.db.exec('COMMIT')
        return transferred
          ? { disposition: 'retained', resource: transferred, reason: 'ownership_transferred' }
          : { disposition: 'retained', resource: null, reason: 'no_owned_resource' }
      }
      if (resource.release_state === 'released' || resource.ownership_state === 'released') {
        this.db.exec('COMMIT')
        return { disposition: 'already_released', resource }
      }
      if (resource.ownership_state === 'external') {
        this.db.exec('COMMIT')
        return {
          disposition: 'retained',
          resource,
          reason: (resource.retained_reason as WorkerTerminalRetainedReason) ?? 'external_terminal'
        }
      }
      if (resource.ownership_state === 'user_owned') {
        this.db.exec('COMMIT')
        return { disposition: 'retained', resource, reason: 'user_takeover' }
      }
      if (resource.ownership_state === 'transferred') {
        this.db.exec('COMMIT')
        return { disposition: 'retained', resource, reason: 'ownership_transferred' }
      }
      if (
        resource.release_state === 'unknown' ||
        (resource.release_state === 'retained' && resource.retained_reason === 'user_requested')
      ) {
        this.db
          .prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?')
          .run(dispatchId)
      }
      this.db
        .prepare(
          `UPDATE worker_terminal_resources
           SET release_state = CASE
                 WHEN release_state = 'releasing' THEN 'releasing'
                 ELSE 'requested'
               END,
               retained_reason = NULL,
               release_requested_at = COALESCE(release_requested_at, datetime('now')),
               release_error = NULL, updated_at = datetime('now')
           WHERE id = ? AND release_state IN ('not_requested', 'retained', 'requested', 'releasing', 'unknown')`
        )
        .run(resource.id)
      this.db.exec('COMMIT')
      return {
        disposition: 'requested',
        resource: this.getWorkerTerminalResource(resource.id) as WorkerTerminalResourceRow
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  storeWorkerTerminalArchive(params: {
    dispatchId: string
    resourceId: string
    kind: 'transcript_pin' | 'terminal_tail'
    content: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO worker_terminal_archives (dispatch_id, resource_id, kind, content)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(dispatch_id) DO UPDATE SET
           resource_id = excluded.resource_id, kind = excluded.kind, content = excluded.content`
      )
      .run(params.dispatchId, params.resourceId, params.kind, params.content)
  }

  commitWorkerTerminalArchiveForRelease(params: {
    dispatchId: string
    resourceId: string
    kind?: 'transcript_pin' | 'terminal_tail'
    content?: string
    archiveSource: 'transcript' | 'terminal'
    archiveStatus: Extract<WorkerTerminalArchiveStatus, 'captured' | 'empty'>
  }): WorkerTerminalResourceRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const resource = this.getWorkerTerminalResource(params.resourceId)
      if (
        resource?.owner_dispatch_id === params.dispatchId &&
        resource.ownership_state === 'owned' &&
        resource.release_state === 'requested'
      ) {
        if (params.kind && params.content !== undefined) {
          this.storeWorkerTerminalArchive({
            dispatchId: params.dispatchId,
            resourceId: params.resourceId,
            kind: params.kind,
            content: params.content
          })
        }
        const archive = this.getWorkerTerminalArchive(params.dispatchId)
        if (!archive || archive.resource_id !== params.resourceId) {
          throw new OrchestrationError(
            'archive_failed',
            `Output could not be preserved for Dispatch ${params.dispatchId}; the terminal was retained.`
          )
        }
        this.db
          .prepare(
            `UPDATE worker_terminal_resources
             SET release_state = 'releasing', archive_source = ?, archive_status = ?,
                 updated_at = datetime('now')
             WHERE id = ? AND owner_dispatch_id = ? AND ownership_state = 'owned'
               AND release_state = 'requested'`
          )
          .run(params.archiveSource, params.archiveStatus, params.resourceId, params.dispatchId)
      }
      const updated = this.getWorkerTerminalResource(params.resourceId) as WorkerTerminalResourceRow
      this.db.exec('COMMIT')
      return updated
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getWorkerTerminalArchive(dispatchId: string): WorkerTerminalArchiveRow | undefined {
    return this.db
      .prepare('SELECT * FROM worker_terminal_archives WHERE dispatch_id = ?')
      .get(dispatchId) as WorkerTerminalArchiveRow | undefined
  }

  settleWorkerTerminalRelease(resourceId: string): WorkerTerminalResourceRow {
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'released', ownership_state = 'released',
             release_completed_at = datetime('now'), release_error = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND release_state IN ('requested', 'releasing', 'unknown')`
      )
      .run(resourceId)
    return this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
  }

  markWorkerTerminalReleaseUnknown(resourceId: string, reason: string): WorkerTerminalResourceRow {
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'unknown', release_error = ?, updated_at = datetime('now')
         WHERE id = ? AND release_state IN ('requested', 'releasing')`
      )
      .run(reason, resourceId)
    return this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
  }

  revertWorkerTerminalReleaseToRetained(
    resourceId: string,
    reason: WorkerTerminalRetainedReason
  ): WorkerTerminalResourceRow {
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'retained', retained_reason = ?, updated_at = datetime('now')
         WHERE id = ? AND release_state IN ('requested', 'releasing')`
      )
      .run(reason, resourceId)
    return this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
  }

  retainWorkerTerminalResource(
    dispatchId: string
  ):
    | { disposition: 'retained'; resource: WorkerTerminalResourceRow }
    | { disposition: 'already_released'; resource: WorkerTerminalResourceRow }
    | { disposition: 'release_committed'; resource: WorkerTerminalResourceRow }
    | { disposition: 'no_owned_resource'; resource: null } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const resource = this.getWorkerTerminalResourceByOwner(dispatchId)
      if (!resource) {
        this.db.exec('COMMIT')
        return { disposition: 'no_owned_resource', resource: null }
      }
      if (resource.release_state === 'released') {
        this.db.exec('COMMIT')
        return { disposition: 'already_released', resource }
      }
      this.db
        .prepare(
          `UPDATE worker_terminal_resources
           SET release_state = 'retained', retained_reason = 'user_requested',
               updated_at = datetime('now')
           WHERE id = ? AND release_state IN ('not_requested', 'retained', 'requested')`
        )
        .run(resource.id)
      const updated = this.getWorkerTerminalResource(resource.id) as WorkerTerminalResourceRow
      if (updated.release_state !== 'retained') {
        this.db.exec('COMMIT')
        return { disposition: 'release_committed', resource: updated }
      }
      this.db.prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?').run(dispatchId)
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource: updated }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // Real user input relinquishes orchestration ownership durably; programmatic prompt delivery,
  // query auto-replies, resize, and output never reach this path.
  markWorkerTerminalUserOwned(paneKey: string): number {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const exact = this.db
        .prepare(
          `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
            WHERE pane_key = ? AND ownership_state = 'owned'
              AND release_state IN ('not_requested', 'retained', 'requested')`
        )
        .all(paneKey) as { id: string; owner_dispatch_id: string; pane_key: string }[]
      const candidates =
        exact.length > 0
          ? exact
          : (
              this.db
                .prepare(
                  `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
                  WHERE ownership_state = 'owned'
                    AND release_state IN ('not_requested', 'retained', 'requested')
                    AND pane_key IS NOT NULL`
                )
                .all() as { id: string; owner_dispatch_id: string; pane_key: string }[]
            ).filter((candidate) => isEquivalentPaneKey(candidate.pane_key, paneKey))
      const update = this.db.prepare(
        `UPDATE worker_terminal_resources
         SET ownership_state = 'user_owned', release_state = 'retained',
             retained_reason = 'user_takeover', updated_at = datetime('now')
         WHERE id = ? AND ownership_state = 'owned'
           AND release_state IN ('not_requested', 'retained', 'requested')`
      )
      let changed = 0
      for (const candidate of candidates) {
        const result = Number(update.run(candidate.id).changes)
        if (result > 0) {
          this.db
            .prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?')
            .run(candidate.owner_dispatch_id)
          changed += result
        }
      }
      this.db.exec('COMMIT')
      return changed
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listWorkerTerminalReleaseBacklog(): WorkerTerminalResourceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM worker_terminal_resources
          WHERE release_state IN ('requested', 'releasing')
          ORDER BY release_requested_at ASC`
      )
      .all() as WorkerTerminalResourceRow[]
  }

  listWorkerTerminalResources(params: { runId?: string } = {}): {
    dispatchId: string
    taskId: string
    runId: string
    workerState: WorkerDispatchState
    dispatchStatus: DispatchStatus
    agentTerminalHandle: string | null
    terminalState: WorkerTerminalListState | null
    resource: WorkerTerminalResourceRow | null
  }[] {
    const rows = this.db
      .prepare(
        `SELECT w.dispatch_id, w.state AS worker_state, w.agent_terminal_handle,
                d.task_id, d.run_id, d.status AS dispatch_status
           FROM worker_dispatches w
           JOIN dispatch_contexts d ON d.id = w.dispatch_id
          ${params.runId ? 'WHERE d.run_id = ?' : ''}
          ORDER BY w.created_at ASC`
      )
      .all(...(params.runId ? [params.runId] : [])) as {
      dispatch_id: string
      worker_state: WorkerDispatchState
      agent_terminal_handle: string | null
      task_id: string
      run_id: string
      dispatch_status: DispatchStatus
    }[]
    const resources = this.db
      .prepare(
        `SELECT r.* FROM worker_terminal_resources r
           JOIN dispatch_contexts d ON d.id = r.owner_dispatch_id
          ${params.runId ? 'WHERE d.run_id = ?' : ''}`
      )
      .all(...(params.runId ? [params.runId] : [])) as WorkerTerminalResourceRow[]
    const resourceByOwner = new Map(
      resources.map((resource) => [resource.owner_dispatch_id, resource])
    )
    return rows.map((row) => {
      const resource = resourceByOwner.get(row.dispatch_id) ?? null
      return {
        dispatchId: row.dispatch_id,
        taskId: row.task_id,
        runId: row.run_id,
        workerState: row.worker_state,
        dispatchStatus: row.dispatch_status,
        agentTerminalHandle: row.agent_terminal_handle,
        terminalState: deriveWorkerTerminalListState({
          workerState: row.worker_state,
          agentTerminalHandle: row.agent_terminal_handle,
          resource
        }),
        resource
      }
    })
  }

  createDispatchContext(
    taskId: string,
    assigneeHandle: string,
    // Why: pane key is the remint-stable identity behind the handle — lets worker_done ownership survive handle reissue.
    assigneePaneKey?: string,
    launchTokenHash?: string,
    processIncarnation?: string
  ): DispatchContextRow {
    const task = this.getTask(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }
    if (task.status !== 'ready') {
      throw new Error(`Task ${taskId} is ${task.status}; only ready tasks can be dispatched`)
    }

    // Why: lock on pane identity too, so a reminted handle can't open a second concurrent dispatch on the same pane.
    const existing = this.findActiveDispatchForAssignee(assigneeHandle, assigneePaneKey)

    if (existing) {
      throw new Error(
        `Terminal ${assigneeHandle} already has an active dispatch (${existing.id} for task ${existing.task_id})`
      )
    }

    // Carry forward failure_count so the circuit breaker accumulates across retries for the same task.
    const prior = this.db
      .prepare('SELECT MAX(failure_count) as max_failures FROM dispatch_contexts WHERE task_id = ?')
      .get(taskId) as { max_failures: number | null } | undefined
    const priorFailures = prior?.max_failures ?? 0

    const id = generateId('ctx')
    this.db
      .prepare(
        `INSERT INTO dispatch_contexts (
           id, run_id, task_id, contract_version, launch_token_hash,
           assignee_handle, assignee_pane_key, process_incarnation,
           status, failure_count, dispatched_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', ?, datetime('now'))`
      )
      .run(
        id,
        task.run_id,
        taskId,
        CURRENT_CONTRACT_VERSION,
        launchTokenHash ?? null,
        assigneeHandle,
        assigneePaneKey ?? null,
        processIncarnation ?? null,
        priorFailures
      )
    this.hasAnyDispatchContextsCache = true

    this.db.prepare("UPDATE tasks SET status = 'dispatched' WHERE id = ?").run(taskId)

    return this.db
      .prepare('SELECT * FROM dispatch_contexts WHERE id = ?')
      .get(id) as DispatchContextRow
  }

  getDispatchContext(taskId: string): DispatchContextRow | undefined {
    return this.db
      .prepare('SELECT * FROM dispatch_contexts WHERE task_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(taskId) as DispatchContextRow | undefined
  }

  getDispatchContextById(dispatchId: string): DispatchContextRow | undefined {
    return this.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(dispatchId) as
      | DispatchContextRow
      | undefined
  }

  commitDispatchLaunchTokenHash(dispatchId: string, launchTokenHash: string): DispatchContextRow {
    const dispatch = this.getDispatchContextById(dispatchId)
    if (!dispatch) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
    }
    if (dispatch.contract_version !== CURRENT_CONTRACT_VERSION) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${dispatchId} does not use the current contract.`
      )
    }
    if (dispatch.launch_token_hash && dispatch.launch_token_hash !== launchTokenHash) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${dispatchId} already has a different launch-token commitment.`
      )
    }
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET launch_token_hash = COALESCE(launch_token_hash, ?)
         WHERE id = ?`
      )
      .run(launchTokenHash, dispatchId)
    return this.getDispatchContextById(dispatchId) as DispatchContextRow
  }

  mintDispatchCapability(params: {
    dispatchId: string
    paneKey: string
    processIncarnation: string
  }): string {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    if (!dispatch || (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not active.`
      )
    }
    const capability = `dcap_${randomBytes(32).toString('base64url')}`
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET capability_hash = ?, assignee_pane_key = ?, process_incarnation = ?,
             capability_revoked_at = NULL
         WHERE id = ?`
      )
      .run(
        hashDispatchCapability(capability),
        params.paneKey,
        params.processIncarnation,
        params.dispatchId
      )
    return capability
  }

  verifyDispatchCapability(params: {
    dispatchId: string
    capability: string | undefined
    paneKey: string | undefined
    processIncarnation: string | undefined
  }): { valid: true } | { valid: false; reason: string } {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    if (!dispatch) {
      return { valid: false, reason: `Dispatch ${params.dispatchId} was not found.` }
    }
    if (!dispatch.capability_hash) {
      return { valid: false, reason: `Dispatch ${params.dispatchId} has no lifecycle capability.` }
    }
    if (dispatch.capability_revoked_at) {
      return { valid: false, reason: `Dispatch ${params.dispatchId} capability is revoked.` }
    }
    if (!params.capability) {
      return { valid: false, reason: 'The Dispatch capability is missing.' }
    }
    const expected = Buffer.from(dispatch.capability_hash, 'hex')
    const observed = Buffer.from(hashDispatchCapability(params.capability), 'hex')
    if (expected.length !== observed.length || !timingSafeEqual(expected, observed)) {
      return { valid: false, reason: 'The Dispatch capability is invalid.' }
    }
    if (
      !dispatch.assignee_pane_key ||
      !params.paneKey ||
      !isEquivalentPaneKey(dispatch.assignee_pane_key, params.paneKey)
    ) {
      return { valid: false, reason: 'The caller is not the Dispatch pane.' }
    }
    if (
      !dispatch.process_incarnation ||
      !params.processIncarnation ||
      dispatch.process_incarnation !== params.processIncarnation
    ) {
      return { valid: false, reason: 'The Dispatch process incarnation changed.' }
    }
    return { valid: true }
  }

  revokeDispatchCapability(dispatchId: string): void {
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
         WHERE id = ?`
      )
      .run(dispatchId)
  }

  getActiveDispatchForTerminal(handle: string): DispatchContextRow | undefined {
    return this.findActiveDispatchForAssignee(handle)
  }

  /**
   * Cheap "are there any dispatch rows at all" probe. When false, no terminal
   * can have an active or recent-completed dispatch, so orchestration-context
   * builders can skip their per-terminal query fan-out entirely. Cached after
   * the first probe; createDispatchContext marks it true, resets clear it.
   */
  hasAnyDispatchContexts(): boolean {
    if (this.hasAnyDispatchContextsCache === undefined) {
      const row = this.db.prepare('SELECT 1 FROM dispatch_contexts LIMIT 1').get()
      this.hasAnyDispatchContextsCache = row !== undefined
    }
    return this.hasAnyDispatchContextsCache
  }

  getActiveDispatchForIdentity(handle: string, paneKey?: string): DispatchContextRow | undefined {
    return this.findActiveDispatchForAssignee(handle, paneKey)
  }

  private findActiveDispatchForAssignee(
    assigneeHandle: string,
    assigneePaneKey?: string
  ): DispatchContextRow | undefined {
    const byHandle = this.db
      .prepare(
        "SELECT * FROM dispatch_contexts WHERE assignee_handle = ? AND status IN ('pending', 'dispatched') LIMIT 1"
      )
      .get(assigneeHandle) as DispatchContextRow | undefined
    if (byHandle) {
      return byHandle
    }

    if (!assigneePaneKey) {
      return undefined
    }

    const actives = this.db
      .prepare(
        `SELECT * FROM dispatch_contexts
         WHERE assignee_pane_key IS NOT NULL
           AND status IN ('pending', 'dispatched')
           AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?`
      )
      .all(paneKeyMatchSuffix(assigneePaneKey)) as DispatchContextRow[]

    for (const row of actives) {
      if (row.assignee_pane_key && isEquivalentPaneKey(row.assignee_pane_key, assigneePaneKey)) {
        return row
      }
    }
    return undefined
  }

  getLatestDispatchForTerminal(handle: string): DispatchContextRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM dispatch_contexts WHERE assignee_handle = ? ORDER BY rowid DESC LIMIT 1'
      )
      .get(handle) as DispatchContextRow | undefined
  }

  completeDispatch(ctxId: string): void {
    this.db
      .prepare(
        "UPDATE dispatch_contexts SET status = 'completed', completed_at = datetime('now'), capability_revoked_at = COALESCE(capability_revoked_at, datetime('now')) WHERE id = ?"
      )
      .run(ctxId)
  }

  completeActiveDispatchForTask(taskId: string): void {
    const active = this.db
      .prepare(
        "SELECT * FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched') ORDER BY rowid DESC LIMIT 1"
      )
      .get(taskId) as DispatchContextRow | undefined
    if (active) {
      this.completeDispatch(active.id)
    }
  }

  settleWorkerReport(params: {
    taskId: string
    dispatchId: string
    outcome: WorkerReportOutcome
    result: string
  }): WorkerReportSettlement {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const settlement = this.settleWorkerReportInTransaction(params)
      this.db.exec('COMMIT')
      return settlement
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private settleWorkerReportInTransaction(params: {
    taskId: string
    dispatchId: string
    outcome: WorkerReportOutcome
    result: string
  }): WorkerReportSettlement {
    const task = this.getTask(params.taskId)
    if (!task) {
      return { action: 'rejected', code: 'unknown_task', reason: `Unknown task ${params.taskId}.` }
    }
    const dispatch = this.getDispatchContextById(params.dispatchId)
    if (!dispatch) {
      return {
        action: 'rejected',
        code: 'unknown_dispatch',
        reason: `Unknown dispatch ${params.dispatchId}.`
      }
    }
    if (dispatch.task_id !== params.taskId) {
      return {
        action: 'rejected',
        code: 'task_dispatch_mismatch',
        reason: `Dispatch ${params.dispatchId} belongs to task ${dispatch.task_id}, not ${params.taskId}.`
      }
    }

    const expectedDispatchStatus = params.outcome === 'succeeded' ? 'completed' : 'failed'
    const expectedTaskStatus = params.outcome === 'succeeded' ? 'completed' : 'failed'
    if (dispatch.status === expectedDispatchStatus && task.status === expectedTaskStatus) {
      return { action: 'settled', outcome: params.outcome, duplicate: true }
    }
    if (dispatch.status !== 'dispatched' || task.status !== 'dispatched') {
      return {
        action: 'rejected',
        code: 'inactive_dispatch',
        reason: `inactive dispatch ${params.dispatchId}: it or task ${params.taskId} is already settled.`
      }
    }
    const latest = this.getDispatchContext(params.taskId)
    if (latest?.id !== params.dispatchId) {
      return {
        action: 'rejected',
        code: 'stale_dispatch',
        reason: `Dispatch ${params.dispatchId} is not the current dispatch for task ${params.taskId}.`
      }
    }

    this.db.exec('SAVEPOINT settle_worker_report')
    const dispatchUpdate = this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET status = ?, completed_at = datetime('now'),
             last_failure = CASE WHEN ? = 'failed' THEN ? ELSE last_failure END,
             capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
         WHERE id = ? AND status = 'dispatched'`
      )
      .run(expectedDispatchStatus, expectedDispatchStatus, params.result, params.dispatchId)
    const taskUpdate = this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, result = ?, completed_at = datetime('now')
         WHERE id = ? AND status = 'dispatched'`
      )
      .run(expectedTaskStatus, params.result, params.taskId)
    if (dispatchUpdate.changes !== 1 || taskUpdate.changes !== 1) {
      this.db.exec('ROLLBACK TO settle_worker_report')
      this.db.exec('RELEASE settle_worker_report')
      return {
        action: 'rejected',
        code: 'inactive_dispatch',
        reason: `Dispatch ${params.dispatchId} changed while its worker report was settling.`
      }
    }
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = ?, stage = 'settled', updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'ready'`
      )
      .run(params.outcome === 'succeeded' ? 'succeeded' : 'failed', params.dispatchId)
    this.closeQuestionsForDispatch(params.dispatchId)
    if (params.outcome === 'succeeded') {
      this.promoteReadyTasks(params.taskId)
    }
    this.db.exec('RELEASE settle_worker_report')
    return { action: 'settled', outcome: params.outcome, duplicate: false }
  }

  failActiveDispatchForTask(taskId: string, error: string): DispatchContextRow | undefined {
    const active = this.db
      .prepare(
        "SELECT * FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched') ORDER BY rowid DESC LIMIT 1"
      )
      .get(taskId) as DispatchContextRow | undefined
    return active ? this.failDispatch(active.id, error) : undefined
  }

  // Why: only bump status='dispatched' — a zombie heartbeat from a finished dispatch would mask a hung retry from the stale detector (§5.3.4).
  recordHeartbeat(dispatchId: string, at: string): void {
    this.db
      .prepare(
        "UPDATE dispatch_contexts SET last_heartbeat_at = ? WHERE id = ? AND status = 'dispatched'"
      )
      .run(at, dispatchId)
  }

  // Why: dispatched_at grace skips workers still within their first heartbeat interval; julianday() vs raw-TEXT compare avoids misflagging space-format timestamps as stale (#8452).
  getStaleDispatches(thresholdIso: string): DispatchContextRow[] {
    return this.db
      .prepare(
        `SELECT * FROM dispatch_contexts
         WHERE status = 'dispatched'
           AND dispatched_at IS NOT NULL
           AND julianday(dispatched_at) < julianday(?)
           AND (last_heartbeat_at IS NULL OR julianday(last_heartbeat_at) < julianday(?))`
      )
      .all(thresholdIso, thresholdIso) as DispatchContextRow[]
  }

  failDispatch(ctxId: string, error: string): DispatchContextRow | undefined {
    const ctx = this.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(ctxId) as
      | DispatchContextRow
      | undefined
    if (!ctx) {
      return undefined
    }

    const newFailureCount = ctx.failure_count + 1
    const newStatus: DispatchStatus = newFailureCount >= 3 ? 'circuit_broken' : 'failed'

    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET status = ?, failure_count = ?, last_failure = ?,
             completed_at = COALESCE(completed_at, datetime('now')),
             capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
         WHERE id = ?`
      )
      .run(newStatus, newFailureCount, error, ctxId)

    // Why: back to 'ready' not 'pending' — 'pending' would strand it since promoteReadyTasks only runs when a dep completes.
    const taskStatus: TaskStatus = newStatus === 'circuit_broken' ? 'failed' : 'ready'
    this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(taskStatus, ctx.task_id)

    return this.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(ctxId) as
      | DispatchContextRow
      | undefined
  }

  // ── Decision Gates ──

  createGate(gate: { taskId: string; question: string; options?: string[] }): DecisionGateRow {
    const id = generateId('gate')
    const optionsJson = JSON.stringify(gate.options ?? [])
    this.db
      .prepare(
        'INSERT INTO decision_gates (id, run_id, task_id, question, options) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        id,
        this.getTask(gate.taskId)?.run_id ?? LEGACY_RUN_ID,
        gate.taskId,
        gate.question,
        optionsJson
      )

    this.completeActiveDispatchForTask(gate.taskId)
    this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(gate.taskId)

    return this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(id) as DecisionGateRow
  }

  resolveGate(gateId: string, resolution: string): DecisionGateRow | undefined {
    const gate = this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(gateId) as
      | DecisionGateRow
      | undefined
    if (!gate) {
      return undefined
    }

    this.db
      .prepare(
        "UPDATE decision_gates SET status = 'resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ?"
      )
      .run(resolution, gateId)

    // Why: set to 'ready' (not the previous status) so the coordinator re-dispatches the worker with the resolution context.
    this.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(gate.task_id)

    return this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(gateId) as
      | DecisionGateRow
      | undefined
  }

  timeoutGate(gateId: string): DecisionGateRow | undefined {
    this.db
      .prepare(
        "UPDATE decision_gates SET status = 'timeout', resolved_at = datetime('now') WHERE id = ?"
      )
      .run(gateId)
    return this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(gateId) as
      | DecisionGateRow
      | undefined
  }

  listGates(filter?: { taskId?: string; status?: GateStatus }): DecisionGateRow[] {
    if (filter?.taskId && filter?.status) {
      return this.db
        .prepare(
          'SELECT * FROM decision_gates WHERE task_id = ? AND status = ? ORDER BY created_at'
        )
        .all(filter.taskId, filter.status) as DecisionGateRow[]
    }
    if (filter?.taskId) {
      return this.db
        .prepare('SELECT * FROM decision_gates WHERE task_id = ? ORDER BY created_at')
        .all(filter.taskId) as DecisionGateRow[]
    }
    if (filter?.status) {
      return this.db
        .prepare('SELECT * FROM decision_gates WHERE status = ? ORDER BY created_at')
        .all(filter.status) as DecisionGateRow[]
    }
    return this.db
      .prepare('SELECT * FROM decision_gates ORDER BY created_at')
      .all() as DecisionGateRow[]
  }

  getGate(id: string): DecisionGateRow | undefined {
    return this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(id) as
      | DecisionGateRow
      | undefined
  }

  // ── Coordinator Runs ──

  createCoordinatorRun(run: {
    spec: string
    coordinatorHandle: string
    pollIntervalMs?: number
  }): CoordinatorRun {
    const id = generateId('run')
    this.db
      .prepare(
        "INSERT INTO coordinator_runs (id, spec, status, coordinator_handle, poll_interval_ms) VALUES (?, ?, 'running', ?, ?)"
      )
      .run(id, run.spec, run.coordinatorHandle, run.pollIntervalMs ?? 2000)
    return this.db.prepare('SELECT * FROM coordinator_runs WHERE id = ?').get(id) as CoordinatorRun
  }

  getCoordinatorRun(id: string): CoordinatorRun | undefined {
    return this.db.prepare('SELECT * FROM coordinator_runs WHERE id = ?').get(id) as
      | CoordinatorRun
      | undefined
  }

  updateCoordinatorRun(id: string, status: CoordinatorStatus): CoordinatorRun | undefined {
    const completedAt =
      status === 'completed' || status === 'failed' ? new Date().toISOString() : null
    this.db
      .prepare(
        'UPDATE coordinator_runs SET status = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?'
      )
      .run(status, completedAt, id)
    return this.getCoordinatorRun(id)
  }

  getActiveCoordinatorRun(): CoordinatorRun | undefined {
    return this.db
      .prepare(
        "SELECT * FROM coordinator_runs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as CoordinatorRun | undefined
  }

  // ── Queries for Coordinator ──

  getIdleTerminals(excludeHandles: string[] = []): string[] {
    const active = this.db
      .prepare(
        "SELECT DISTINCT assignee_handle FROM dispatch_contexts WHERE status IN ('pending', 'dispatched')"
      )
      .all() as { assignee_handle: string }[]
    const busyHandles = new Set(active.map((r) => r.assignee_handle))
    for (const h of excludeHandles) {
      busyHandles.add(h)
    }
    // Return handles from message history that aren't busy
    const allHandles = this.db
      .prepare(
        'SELECT DISTINCT to_handle FROM messages UNION SELECT DISTINCT from_handle FROM messages'
      )
      .all() as { to_handle: string }[]
    return [...new Set(allHandles.map((r) => r.to_handle))].filter((h) => !busyHandles.has(h))
  }

  // ── Lifecycle ──

  private runResetTransaction(statements: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec(statements)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  resetAll(): void {
    // Why: retain mutation receipts so a lost reset response cannot replay as a new mutation.
    this.runResetTransaction(`
      DELETE FROM coordinator_runs;
      DELETE FROM decision_gates;
      DELETE FROM remote_questions;
      DELETE FROM question_threads;
      DELETE FROM deliveries;
      DELETE FROM legacy_mail_receipts;
      DELETE FROM legacy_operation_receipts;
      DELETE FROM legacy_compatibility_principals;
      DELETE FROM legacy_adoptions;
      DELETE FROM federation_relay_items;
      DELETE FROM remote_dispatch_attachments;
      DELETE FROM federated_dispatches;
      DELETE FROM worker_terminal_archives;
      DELETE FROM worker_terminal_resources;
      DELETE FROM worker_dispatches;
      DELETE FROM dispatch_contexts;
      DELETE FROM tasks;
      DELETE FROM messages;
      DELETE FROM runs;
      INSERT INTO runs (id, objective, home_database, consumer_generation, legacy)
        VALUES ('${LEGACY_RUN_ID}', 'Legacy orchestration state (inspect only)', 'this_database', 0, 1);
    `)
    this.hasAnyDispatchContextsCache = undefined
  }

  resetTasks(): void {
    this.runResetTransaction(`
      DELETE FROM coordinator_runs;
      DELETE FROM decision_gates;
      DELETE FROM remote_questions;
      DELETE FROM question_threads;
      DELETE FROM legacy_mail_receipts;
      DELETE FROM legacy_operation_receipts;
      DELETE FROM legacy_compatibility_principals;
      DELETE FROM legacy_adoptions;
      DELETE FROM federation_relay_items;
      DELETE FROM remote_dispatch_attachments;
      DELETE FROM federated_dispatches;
      DELETE FROM worker_terminal_archives;
      DELETE FROM worker_terminal_resources;
      DELETE FROM worker_dispatches;
      DELETE FROM dispatch_contexts;
      DELETE FROM tasks;
    `)
    this.hasAnyDispatchContextsCache = undefined
  }

  resetMessages(): void {
    // Why: relay rows carry contiguous cross-server cursors, not just inbox history.
    this.runResetTransaction(`
      DELETE FROM legacy_mail_receipts;
      DELETE FROM question_threads;
      DELETE FROM deliveries;
      DELETE FROM messages;
    `)
  }

  close(): void {
    this.db.close()
  }
}
