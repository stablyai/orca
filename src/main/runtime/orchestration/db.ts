/* eslint-disable max-lines -- Why: the orchestration DB keeps schema creation, message CRUD, task DAG resolution, and dispatch context management in one class so transactional invariants (e.g. promoteReadyTasks running inside the same writer as updateTaskStatus) are enforced by locality. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import Database from '../../sqlite/sync-database'
import type {
  MessageType,
  MessagePriority,
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
  QuestionRow,
  QuestionStatus,
  MutationReceiptRow,
  MutationState,
  WorkerDispatchRow,
  WorkerDispatchState,
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

// Why: leaf UUID is the remint-stable pane identity (tab half changes on break-out); exact match covers legacy/unparseable keys.
function isEquivalentPaneKey(a: string, b: string): boolean {
  if (a === b) {
    return true
  }
  const aLeaf = parsePaneKey(a)?.leafId
  const bLeaf = parsePaneKey(b)?.leafId
  return Boolean(aLeaf && bLeaf && aLeaf === bLeaf)
}

export type {
  MessageType,
  MessagePriority,
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

export const LEGACY_RUN_ID = ORCHESTRATION_LEGACY_RUN_ID

// Schema versions: v2 'heartbeat'+last_heartbeat_at, v3 delivered_at, v4 task-creator terminal, v5 task_title/display_name, v6 pane identity, v7 lightweight Runs, v8 crash-safe Run deliveries, v9 durable question threads, v10 Dispatch capabilities, v11 durable mutation receipts, v12 composed worker state, v18 post-v6 version-skew repair.
const SCHEMA_VERSION = 18

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

      CREATE TABLE IF NOT EXISTS coordinator_runs (
        id                  TEXT PRIMARY KEY,
        spec                TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'idle'
          CHECK(status IN ('idle', 'running', 'completed', 'failed')),
        coordinator_handle  TEXT NOT NULL,
        poll_interval_ms    INTEGER NOT NULL DEFAULT 2000,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at        TEXT
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

    this.db.exec('BEGIN')
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
      this.createUndeliveredInboxIndexIfPossible()

      this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
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
      this.unbindOtherRunsForPane(params.coordinatorPaneKey, params.runId)
      if (!sameBinding || run.coordinator_handle !== params.coordinatorHandle) {
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

  listRuns(): RunRow[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as RunRow[]).map(
      exposeRunTimestamps
    )
  }

  getCurrentRunForPane(paneKey: string): RunRow | undefined {
    const runs = this.db
      .prepare('SELECT * FROM runs WHERE coordinator_pane_key IS NOT NULL AND legacy = 0')
      .all() as RunRow[]
    const run = runs.find(
      (candidate) =>
        candidate.coordinator_pane_key !== null &&
        isEquivalentPaneKey(candidate.coordinator_pane_key, paneKey)
    )
    return run ? exposeRunTimestamps(run) : undefined
  }

  private getRunRaw(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
  }

  private unbindOtherRunsForPane(paneKey: string, exceptRunId?: string): void {
    const bound = this.db
      .prepare('SELECT * FROM runs WHERE coordinator_pane_key IS NOT NULL AND legacy = 0')
      .all() as RunRow[]
    for (const run of bound) {
      if (
        run.id !== exceptRunId &&
        run.coordinator_pane_key &&
        isEquivalentPaneKey(run.coordinator_pane_key, paneKey)
      ) {
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
  }): MessageRow {
    const runId = msg.runId ?? LEGACY_RUN_ID
    this.requireRun(runId)
    const id = msg.id ?? generateId('msg')
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, run_id, from_handle, to_handle, subject, body, type, priority, thread_id, payload, sender_pane_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      runId,
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

  getUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',')
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages WHERE to_handle = ? AND read = 0 AND type IN (${placeholders}) ORDER BY sequence`
          )
          .all(toHandle, ...types) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare('SELECT * FROM messages WHERE to_handle = ? AND read = 0 ORDER BY sequence')
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
            `SELECT * FROM messages WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL AND type IN (${placeholders}) ORDER BY sequence`
          )
          .all(toHandle, ...types) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          'SELECT * FROM messages WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL ORDER BY sequence'
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
        'INSERT INTO tasks (id, run_id, parent_id, created_by_terminal_handle, task_title, display_name, spec, status, deps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        runId,
        task.parentId ?? null,
        task.createdByTerminalHandle ?? null,
        display.taskTitle || null,
        display.displayName || null,
        task.spec,
        status,
        depsJson
      )
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
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
             id, run_id, task_id, status, dispatched_at
           ) VALUES (?, ?, ?, 'pending', datetime('now'))`
        )
        .run(id, task.run_id, task.id)
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
    worktreeId: string
    effects: unknown[]
    setupState: string
  }): string {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    const capability = `dcap_${randomBytes(32).toString('base64url')}`
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ?,
               capability_hash = ?, capability_revoked_at = NULL
           WHERE id = ? AND status = 'pending'`
        )
        .run(
          params.handle,
          params.paneKey,
          params.processIncarnation,
          hashDispatchCapability(capability),
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

  createDispatchContext(
    taskId: string,
    assigneeHandle: string,
    // Why: pane key is the remint-stable identity behind the handle — lets worker_done ownership survive handle reissue.
    assigneePaneKey?: string
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
        `INSERT INTO dispatch_contexts (id, run_id, task_id, assignee_handle, assignee_pane_key, status, failure_count, dispatched_at)
         VALUES (?, ?, ?, ?, ?, 'dispatched', ?, datetime('now'))`
      )
      .run(id, task.run_id, taskId, assigneeHandle, assigneePaneKey ?? null, priorFailures)
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
        "SELECT * FROM dispatch_contexts WHERE assignee_pane_key IS NOT NULL AND status IN ('pending', 'dispatched')"
      )
      .all() as DispatchContextRow[]

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
      DELETE FROM federation_relay_items;
      DELETE FROM remote_dispatch_attachments;
      DELETE FROM federated_dispatches;
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
      DELETE FROM federation_relay_items;
      DELETE FROM remote_dispatch_attachments;
      DELETE FROM federated_dispatches;
      DELETE FROM worker_dispatches;
      DELETE FROM dispatch_contexts;
      DELETE FROM tasks;
    `)
    this.hasAnyDispatchContextsCache = undefined
  }

  resetMessages(): void {
    // Why: relay rows carry contiguous cross-server cursors, not just inbox history.
    this.runResetTransaction(`
      DELETE FROM question_threads;
      DELETE FROM deliveries;
      DELETE FROM messages;
    `)
  }

  close(): void {
    this.db.close()
  }
}
