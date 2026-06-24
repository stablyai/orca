/* eslint-disable max-lines -- Why: the orchestration DB keeps schema creation, message CRUD, task DAG resolution, and dispatch context management in one class so transactional invariants (e.g. promoteReadyTasks running inside the same writer as updateTaskStatus) are enforced by locality. */
import { randomBytes } from 'crypto'
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
  CoordinatorRun
} from './types'
import { buildOrchestrationTaskDisplayMetadata } from '../../../shared/orchestration-task-display'

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
  CoordinatorRun
}

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

// Why (#12): raised by startCoordinatorRun when a run is already active *for the
// same target* (repo/worktree). startCoordinatorRun wraps the check+insert in
// BEGIN IMMEDIATE so the guard is atomic across processes (two runtimes / SSH
// sharing one DB file) — the prior in-memory `getActiveCoordinatorRun()` check
// did not span processes, which is how two coordinators clashed. Runs on
// different targets start in parallel. Callers map this to a friendly RPC error.
// Why (#14): the options persisted with a run so resume-on-boot can rebuild its
// coordinator. maxConcurrent/worktreeBacked/workerAgent are the in-memory-only
// coordinator settings that the run row did not record before — losing them on
// restart is what made a faithful resume impossible.
export type CoordinatorRunInsert = {
  spec: string
  coordinatorHandle: string
  pollIntervalMs?: number
  targetKey?: string | null
  maxConcurrent?: number
  worktreeBacked?: boolean
  workerAgent?: string
}

export class CoordinatorRunConflictError extends Error {
  constructor(message = 'A coordinator run is already in progress for this target') {
    super(message)
    this.name = 'CoordinatorRunConflictError'
  }
}

// Why: v1 → v2 added `'heartbeat'` to messages.type CHECK + `last_heartbeat_at`
// column (preamble-hardening PR). v2 → v3 adds `delivered_at` column so
// push-on-idle can distinguish queued-but-undelivered from user-acknowledged
// messages without touching the `read` bit (check-wait PR). v3 → v4 records
// the terminal that created a task so task-record worktree creation can infer
// the parent workspace even when no dispatch context exists. v4 → v5 adds
// explicit task_title/display_name fields for orchestration worker UI labels.
// v5 → v6 adds `coordinator_run_id` to tasks/dispatch_contexts/decision_gates
// (plus run-scoped lookup indexes) so concurrent runs sharing one DB no longer
// poach each other's work (#12). v6 → v7 adds `coordinator_runs.target_key` so
// the run-start guard can reject only a *duplicate run on the same target*
// (repo/worktree) while letting Orcastrators in different repos run in parallel.
// v7 → v8 adds `tasks.target_key` so task OWNERSHIP is target-scoped too —
// adoption and mid-run stamping only bind a task to a run on the same target,
// closing the cross-target poaching gap that per-target run-start alone left
// open. The guard is enforced at write time by startCoordinatorRun
// (BEGIN IMMEDIATE), not by a schema index.
// v8 → v9 adds `coordinator_runs.{max_concurrent,worktree_backed,worker_agent}`
// so resume-on-boot (#14) can rebuild a crashed run's coordinator faithfully —
// the in-memory coordinator (its worktree-backed flag, worker agent, concurrency)
// is otherwise lost on restart, and a wrong guess re-zombies the run.
// v9 → v10 adds `coordinator_runs.resumed_at`, a boot-time-fenced resume claim so
// two runtimes sharing one DB (desktop + `orca serve`) can't both drive a resumed
// run, while a strictly-greater later fence reclaims a crashed resumer's stale claim.
const SCHEMA_VERSION = 10

export class OrchestrationDb {
  private db: Database.Database

  constructor(dbPath: string | ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    this.createTables()
    this.migrate()
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id            TEXT NOT NULL,
        from_handle   TEXT NOT NULL,
        to_handle     TEXT NOT NULL,
        subject       TEXT NOT NULL,
        body          TEXT NOT NULL DEFAULT '',
        type          TEXT NOT NULL DEFAULT 'status'
          CHECK(type IN (
            'status', 'dispatch', 'worker_done', 'merge_ready',
            'escalation', 'handoff', 'decision_gate', 'heartbeat'
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

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
      CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_handle, read);
      CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id);

      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        parent_id     TEXT,
        created_by_terminal_handle TEXT,
        coordinator_run_id TEXT,
        target_key    TEXT,
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
        task_id             TEXT NOT NULL,
        coordinator_run_id  TEXT,
        assignee_handle     TEXT,
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
        task_id       TEXT NOT NULL,
        coordinator_run_id TEXT,
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
        target_key          TEXT,
        max_concurrent      INTEGER,
        worktree_backed     INTEGER,
        worker_agent        TEXT,
        resumed_at          TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at        TEXT
      );
    `)
    this.createUndeliveredInboxIndexIfPossible()
    // Why: the run-scoped lookup indexes depend on the coordinator_run_id
    // columns, which on an upgraded DB only exist after migrate() runs.
    // createTables() runs first (CREATE TABLE IF NOT EXISTS is a no-op on the
    // old shape), so guard on the column and (re)attach after migration too.
    // Fresh DBs already have the columns, so this attaches now.
    this.createRunScopedIndexesIfPossible()
  }

  // Why: `CREATE TABLE IF NOT EXISTS` is a no-op against an existing on-disk
  // DB, so new schema shapes (added columns, widened CHECK constraints) do
  // not reach an upgraded user unless we migrate explicitly. The transaction
  // guarantees atomicity — a mid-migration crash leaves the DB at the prior
  // version because `user_version` is bumped only on success. Idempotent
  // re-invocation is a no-op (current >= SCHEMA_VERSION short-circuit).
  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number
    if (current >= SCHEMA_VERSION) {
      return
    }

    this.db.exec('BEGIN')
    try {
      // v1 → v2: add last_heartbeat_at column; widen messages.type CHECK to
      // include 'heartbeat'. SQLite cannot ALTER a CHECK constraint, so we
      // rebuild the messages table. We also include `delivered_at` in the
      // rebuilt schema so DBs migrating from v1 pick up the v3 column in a
      // single table-rewrite pass (avoids a second messages-rebuild later).
      if (current < 2) {
        if (!this.hasColumn('dispatch_contexts', 'last_heartbeat_at')) {
          this.db.exec(`ALTER TABLE dispatch_contexts ADD COLUMN last_heartbeat_at TEXT`)
        }

        if (!this.messagesTypeCheckAllowsHeartbeat()) {
          // Why — index list is not optional. createTables() already attached
          // idx_messages_id / idx_inbox / idx_messages_undelivered_inbox /
          // idx_thread to the old messages table; DROP TABLE removes those
          // indexes with it. CREATE INDEX IF NOT EXISTS in createTables() only
          // runs on the next process startup, so skipping explicit recreation
          // here would leave message lookups full-scanning for the rest of this
          // process's lifetime — a silent O(N) perf regression.
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
                  'escalation', 'handoff', 'decision_gate', 'heartbeat'
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

      // v2 → v3: add `delivered_at` column to messages. A DB that reached v2
      // via the v1 → v2 rebuild above already has the column (we included
      // it in messages_new); this handles DBs that were at v2 before this
      // release shipped (preamble PR deployed standalone, then check-wait
      // merged). ALTER TABLE is idempotent via the hasColumn probe — a
      // duplicate-column error would abort the whole transaction.
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
      // v5 → v6: per-run isolation (#12). Add coordinator_run_id to the
      // run-scoped tables so each run's task DAG / dispatches / gates are
      // queried in isolation.
      if (current < 6) {
        if (!this.hasColumn('tasks', 'coordinator_run_id')) {
          this.db.exec(`ALTER TABLE tasks ADD COLUMN coordinator_run_id TEXT`)
        }
        if (!this.hasColumn('dispatch_contexts', 'coordinator_run_id')) {
          this.db.exec(`ALTER TABLE dispatch_contexts ADD COLUMN coordinator_run_id TEXT`)
        }
        if (!this.hasColumn('decision_gates', 'coordinator_run_id')) {
          this.db.exec(`ALTER TABLE decision_gates ADD COLUMN coordinator_run_id TEXT`)
        }
      }
      // v6 → v7: per-target run-start guard (#12). target_key identifies the
      // run's repo/worktree so startCoordinatorRun blocks only a duplicate run
      // on the same target, not all concurrency.
      if (current < 7) {
        if (!this.hasColumn('coordinator_runs', 'target_key')) {
          this.db.exec(`ALTER TABLE coordinator_runs ADD COLUMN target_key TEXT`)
        }
      }
      // v7 → v8: per-target task ownership (#12). Without a target on tasks,
      // adoptUnownedTasks claims every unowned task regardless of target — the
      // first concurrent run swallows another target's tasks. target_key scopes
      // adoption and mid-run stamping to one target.
      if (current < 8) {
        if (!this.hasColumn('tasks', 'target_key')) {
          this.db.exec(`ALTER TABLE tasks ADD COLUMN target_key TEXT`)
        }
      }
      // v8 → v9: persist the coordinator options resume-on-boot (#14) needs to
      // rebuild a crashed run's coordinator without guessing. Nullable/additive:
      // pre-existing rows read NULL and resume falls back to defaults.
      if (current < 9) {
        if (!this.hasColumn('coordinator_runs', 'max_concurrent')) {
          this.db.exec(`ALTER TABLE coordinator_runs ADD COLUMN max_concurrent INTEGER`)
        }
        if (!this.hasColumn('coordinator_runs', 'worktree_backed')) {
          this.db.exec(`ALTER TABLE coordinator_runs ADD COLUMN worktree_backed INTEGER`)
        }
        if (!this.hasColumn('coordinator_runs', 'worker_agent')) {
          this.db.exec(`ALTER TABLE coordinator_runs ADD COLUMN worker_agent TEXT`)
        }
      }
      // v9 → v10: the boot-time-fenced resume claim (#14). Nullable/additive.
      if (current < 10) {
        if (!this.hasColumn('coordinator_runs', 'resumed_at')) {
          this.db.exec(`ALTER TABLE coordinator_runs ADD COLUMN resumed_at TEXT`)
        }
      }
      this.createUndeliveredInboxIndexIfPossible()
      // Why: attach run-scoped lookup indexes now that the v6 columns exist
      // (createTables ran before the ALTERs above on an upgraded DB).
      this.createRunScopedIndexesIfPossible()

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

  // Why (#12): the run-scoped lookup indexes depend on the v6 coordinator_run_id
  // columns. Guard on column presence so this is safe to call from createTables
  // (fresh DB / no-op on old DB) and again after migrate() adds the columns.
  private createRunScopedIndexesIfPossible(): void {
    if (this.hasColumn('tasks', 'coordinator_run_id')) {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(coordinator_run_id, status);
        CREATE INDEX IF NOT EXISTS idx_dispatch_run
          ON dispatch_contexts(coordinator_run_id, status);
        CREATE INDEX IF NOT EXISTS idx_gates_run ON decision_gates(coordinator_run_id, status);
      `)
    }
    // Why: tasks.target_key is the v8 column; on an upgraded DB it only exists
    // after migrate() runs, so guard it separately (createTables calls this
    // before migrate). Speeds the target-scoped adoption scan.
    if (this.hasColumn('tasks', 'target_key')) {
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_tasks_target ON tasks(target_key, coordinator_run_id)`
      )
    }
  }

  // Why: sqlite_master stores the original CREATE TABLE SQL including the
  // CHECK clause. Inspecting that text is the cheapest reliable way to tell
  // whether the pre-rebuild schema already knows about 'heartbeat' without
  // needing a dedicated schema_meta row.
  private messagesTypeCheckAllowsHeartbeat(): boolean {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get() as { sql: string } | undefined
    return !!row && row.sql.includes("'heartbeat'")
  }

  // ── Messages ──

  insertMessage(msg: {
    from: string
    to: string
    subject: string
    body?: string
    type?: MessageType
    priority?: MessagePriority
    threadId?: string
    payload?: string
  }): MessageRow {
    const id = generateId('msg')
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, from_handle, to_handle, subject, body, type, priority, thread_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      msg.from,
      msg.to,
      msg.subject,
      msg.body ?? '',
      msg.type ?? 'status',
      msg.priority ?? 'normal',
      msg.threadId ?? null,
      msg.payload ?? null
    )
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow
  }

  getUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',')
      return this.db
        .prepare(
          `SELECT * FROM messages WHERE to_handle = ? AND read = 0 AND type IN (${placeholders}) ORDER BY sequence`
        )
        .all(toHandle, ...types) as MessageRow[]
    }
    return this.db
      .prepare('SELECT * FROM messages WHERE to_handle = ? AND read = 0 ORDER BY sequence')
      .all(toHandle) as MessageRow[]
  }

  // Why: push-on-idle delivery must not replay messages that were already
  // injected into the PTY. `read` flips only when a check-caller consumes a
  // message, so delivered-but-unread rows would otherwise be re-injected on
  // every later idle transition (the replay bug). Filter on
  // `delivered_at IS NULL` so each row is auto-pushed at most once; explicit
  // `check` still sees them via getUnreadMessages.
  getUndeliveredUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',')
      return this.db
        .prepare(
          `SELECT * FROM messages WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL AND type IN (${placeholders}) ORDER BY sequence`
        )
        .all(toHandle, ...types) as MessageRow[]
    }
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL ORDER BY sequence'
      )
      .all(toHandle) as MessageRow[]
  }

  getAllMessages(toHandle: string, limit = 20): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE to_handle = ? ORDER BY sequence DESC LIMIT ?')
      .all(toHandle, limit) as MessageRow[]
  }

  getMessageById(id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
  }

  markAsRead(ids: string[]): void {
    if (ids.length === 0) {
      return
    }
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`UPDATE messages SET read = 1 WHERE id IN (${placeholders})`).run(...ids)
  }

  // Why: `delivered_at` is stamped via SQLite's datetime('now') rather than a
  // JS ISO string so it uses the same 'YYYY-MM-DD HH:MM:SS' UTC shape as the
  // other SQL-default timestamps on this table. A future ORDER BY or
  // comparison against created_at relies on this format consistency.
  // See design doc §3.2.
  markAsDelivered(ids: string[]): void {
    if (ids.length === 0) {
      return
    }
    const placeholders = ids.map(() => '?').join(',')
    this.db
      .prepare(`UPDATE messages SET delivered_at = datetime('now') WHERE id IN (${placeholders})`)
      .run(...ids)
  }

  getInbox(limit = 20): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages ORDER BY sequence DESC LIMIT ?')
      .all(limit) as MessageRow[]
  }

  // Why: used by `check --all` and `inbox --terminal <handle>` — returns every
  // message for a handle regardless of read/delivered state; never touches the
  // read bit. Stale-handle safe: if the handle no longer exists, the query
  // just returns whatever historical rows remain (§3.3).
  getAllMessagesForHandle(toHandle: string, limit = 100, types?: MessageType[]): MessageRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',')
      return this.db
        .prepare(
          `SELECT * FROM messages WHERE to_handle = ? AND type IN (${placeholders}) ORDER BY sequence DESC LIMIT ?`
        )
        .all(toHandle, ...types, limit) as MessageRow[]
    }
    return this.db
      .prepare('SELECT * FROM messages WHERE to_handle = ? ORDER BY sequence DESC LIMIT ?')
      .all(toHandle, limit) as MessageRow[]
  }

  // Why: thread-scoped read for the `orchestration.ask` wait loop. Filtered
  // by `to_handle` so a worker only sees replies addressed to it (not
  // messages it sent), and ordered by `sequence` so the first post-ask
  // reply is returned first. `afterSequence` lets the caller resume past an
  // already-seen marker without re-reading the outbound ask itself. Uses
  // the existing idx_thread index (see createTables) — no new index.
  getThreadMessagesFor(threadId: string, toHandle: string, afterSequence?: number): MessageRow[] {
    if (afterSequence !== undefined) {
      return this.db
        .prepare(
          'SELECT * FROM messages WHERE thread_id = ? AND to_handle = ? AND sequence > ? ORDER BY sequence ASC'
        )
        .all(threadId, toHandle, afterSequence) as MessageRow[]
    }
    return this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? AND to_handle = ? ORDER BY sequence ASC')
      .all(threadId, toHandle) as MessageRow[]
  }

  // ── Tasks ──

  createTask(task: {
    spec: string
    taskTitle?: string
    displayName?: string
    deps?: string[]
    parentId?: string
    createdByTerminalHandle?: string
    // Why (#12): tasks created mid-run are stamped with the active run so the
    // coordinator's run-scoped listTasks sees them. Pre-run tasks pass nothing
    // and stay unowned (NULL) until run-start adoptUnownedTasks() claims them.
    coordinatorRunId?: string
    // Why (#12): the task's repo/worktree target, so adoption only binds it to a
    // run on the same target. NULL when the creator's target is unresolvable.
    targetKey?: string | null
  }): TaskRow {
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
        'INSERT INTO tasks (id, parent_id, created_by_terminal_handle, coordinator_run_id, target_key, task_title, display_name, spec, status, deps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        task.parentId ?? null,
        task.createdByTerminalHandle ?? null,
        task.coordinatorRunId ?? null,
        task.targetKey ?? null,
        display.taskTitle || null,
        display.displayName || null,
        task.spec,
        status,
        depsJson
      )
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow
  }

  // Why (#12): tasks are created via orchestration.taskCreate BEFORE
  // orchestration.run exists, so they start unowned (coordinator_run_id NULL).
  // Run-start adopts every still-unowned task — plus any task whose owning run
  // is no longer running — into the starting run. The "not running" clause is
  // what makes isolation safe across time: a *concurrently running* run's tasks
  // are never adopted, while a stopped/crashed run's leftover tasks are not
  // stranded. The `target_key IS ?` clause makes it safe across *space*: a run
  // adopts ONLY tasks on its own target, so two concurrent runs on different
  // targets can't poach each other's unowned tasks (the round-3 blocker).
  // (Re-attaching a coordinator process to an existing run after a restart is
  // F3's job, #14 — this only transfers task ownership.)
  adoptUnownedTasks(coordinatorRunId: string, targetKey: string | null): number {
    const info = this.db
      .prepare(
        `UPDATE tasks SET coordinator_run_id = ?
         WHERE target_key IS ?
           AND (
             coordinator_run_id IS NULL
             OR coordinator_run_id IN (
               SELECT id FROM coordinator_runs WHERE status != 'running'
             )
           )`
      )
      .run(coordinatorRunId, targetKey)
    // Why: dispatch_contexts/decision_gates copy their task's run at creation,
    // but a dispatch/gate created before the task was adopted (or owned by the
    // run we just reclaimed from) would carry a stale run id. Re-sync the
    // denormalized column so run-scoped dispatch/gate queries stay correct.
    this.db
      .prepare(
        `UPDATE dispatch_contexts SET coordinator_run_id = ?
         WHERE coordinator_run_id IS NOT ?
           AND task_id IN (SELECT id FROM tasks WHERE coordinator_run_id = ?)`
      )
      .run(coordinatorRunId, coordinatorRunId, coordinatorRunId)
    this.db
      .prepare(
        `UPDATE decision_gates SET coordinator_run_id = ?
         WHERE coordinator_run_id IS NOT ?
           AND task_id IN (SELECT id FROM tasks WHERE coordinator_run_id = ?)`
      )
      .run(coordinatorRunId, coordinatorRunId, coordinatorRunId)
    return Number((info as { changes?: number | bigint }).changes ?? 0)
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  }

  // Why (#12): `coordinatorRunId` scopes the listing to a single run. The
  // coordinator always passes its own run id so it never sees (or dispatches)
  // another run's tasks; supervisor/UI callers omit it for a global view.
  listTasks(filter?: {
    status?: TaskStatus
    ready?: boolean
    coordinatorRunId?: string
  }): TaskRow[] {
    const clauses: string[] = []
    const params: Database.BindValue[] = []
    if (filter?.ready) {
      clauses.push("status = 'ready'")
    } else if (filter?.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter?.coordinatorRunId !== undefined) {
      clauses.push('coordinator_run_id = ?')
      params.push(filter.coordinatorRunId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    // Why (F2 #13 round 2/3, must-fix #2): `created_at` is second-granularity, so
    // same-second tasks would otherwise shuffle between reads. The `id` tie-break
    // removes that per-read non-determinism (a stable total order). NOTE: `id` is
    // random (not insertion-monotonic), so this does NOT by itself guarantee
    // implement-before-review — that ORDERING is enforced by deps:[predecessor]
    // (honored by promoteReadyTasks) plus the coordinator's same-track ordering
    // guard (assertTrackOrderingSafe). This sort only stabilizes the read order.
    return this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at, id`)
      .all(...params) as TaskRow[]
  }

  // Why: surfaces the active dispatch (assignee handle + dispatch context id)
  // alongside each task so coordinators can answer "who is working on task X?"
  // from a single query. The LEFT JOIN keeps non-dispatched tasks in the result
  // with NULL assignee/dispatch fields so non-dispatched output stays stable.
  // The inner subquery picks the most recent active dispatch per task to match
  // the semantics of getDispatchContext for dispatched tasks.
  listTasksWithDispatch(filter?: {
    status?: TaskStatus
    ready?: boolean
    coordinatorRunId?: string
  }): (TaskRow & {
    assignee_handle: string | null
    dispatch_id: string | null
    // Why (#6 O1): the active dispatch's lifecycle + liveness, surfaced so the
    // Control Panel sync can render per-worker state (stale heartbeat, etc.).
    // Aliased to avoid colliding with the task's own `status` from `t.*`.
    dispatch_status: DispatchStatus | null
    dispatch_last_heartbeat_at: string | null
    dispatch_dispatched_at: string | null
  })[] {
    const whereClauses: string[] = []
    const params: Database.BindValue[] = []
    if (filter?.ready) {
      whereClauses.push("t.status = 'ready'")
    } else if (filter?.status) {
      whereClauses.push('t.status = ?')
      params.push(filter.status)
    }
    if (filter?.coordinatorRunId !== undefined) {
      whereClauses.push('t.coordinator_run_id = ?')
      params.push(filter.coordinatorRunId)
    }
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''
    const sql = `
      SELECT
        t.*,
        d.assignee_handle    AS assignee_handle,
        d.id                 AS dispatch_id,
        d.status             AS dispatch_status,
        d.last_heartbeat_at  AS dispatch_last_heartbeat_at,
        d.dispatched_at      AS dispatch_dispatched_at
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
      ORDER BY t.created_at, t.id
    `
    return this.db.prepare(sql).all(...params) as (TaskRow & {
      assignee_handle: string | null
      dispatch_id: string | null
      dispatch_status: DispatchStatus | null
      dispatch_last_heartbeat_at: string | null
      dispatch_dispatched_at: string | null
    })[]
  }

  // Why (#6 O1, perf): a cheap high-water mark used to skip rebuilding a run's
  // DAG snapshot on graph-sync ticks where nothing changed. Combines the max
  // rowid of the run's tasks + dispatch_contexts (covers inserts: new task, new
  // dispatch) with the max message sequence for the coordinator handle (covers
  // heartbeat / worker_done arrivals, which drive the task/dispatch UPDATEs that
  // rowid alone would miss). A coordinator-initiated dispatch fail with no new
  // message/row is the one transition this can lag; it self-heals on the next
  // dispatch insert or message — acceptable for a display panel.
  getRunDagChangeToken(coordinatorRunId: string, coordinatorHandle: string): string {
    const taskMax = (
      this.db
        .prepare('SELECT MAX(rowid) AS m FROM tasks WHERE coordinator_run_id = ?')
        .get(coordinatorRunId) as { m: number | null }
    ).m
    const dispatchMax = (
      this.db
        .prepare('SELECT MAX(rowid) AS m FROM dispatch_contexts WHERE coordinator_run_id = ?')
        .get(coordinatorRunId) as { m: number | null }
    ).m
    const messageMax = (
      this.db
        .prepare('SELECT MAX(sequence) AS m FROM messages WHERE to_handle = ?')
        .get(coordinatorHandle) as { m: number | null }
    ).m
    return `${taskMax ?? 0}:${dispatchMax ?? 0}:${messageMax ?? 0}`
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

  // Why: when a task completes, check if any pending tasks that depended on it
  // now have all deps satisfied. If so, promote them to 'ready'. This is the
  // DAG resolution step — it runs synchronously inside the same transaction as
  // the status update, so there's no window where a task is completable but its
  // children haven't been promoted.
  private promoteReadyTasks(completedTaskId: string): void {
    // Why (#12): only consider pending tasks in the same run as the task that
    // just completed, so DAG resolution never promotes another run's tasks.
    const completed = this.getTask(completedTaskId)
    const candidates = this.db
      .prepare('SELECT * FROM tasks WHERE status = ? AND coordinator_run_id IS ?')
      .all('pending', completed?.coordinator_run_id ?? null) as TaskRow[]

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

  createDispatchContext(taskId: string, assigneeHandle: string): DispatchContextRow {
    const task = this.getTask(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }
    if (task.status !== 'ready') {
      throw new Error(`Task ${taskId} is ${task.status}; only ready tasks can be dispatched`)
    }

    // Why (#12): the "already working" guard is scoped to the task's run. A
    // different run reusing the same worker handle (or a zombie dispatch left
    // by a prior/abandoned run) must not block this run's dispatch — that
    // cross-run throw was the observed bug symptom.
    const runId = task.coordinator_run_id
    const existing = this.db
      .prepare(
        "SELECT * FROM dispatch_contexts WHERE assignee_handle = ? AND coordinator_run_id IS ? AND status IN ('pending', 'dispatched')"
      )
      .get(assigneeHandle, runId) as DispatchContextRow | undefined

    if (existing) {
      throw new Error(
        `Terminal ${assigneeHandle} already has an active dispatch (${existing.id} for task ${existing.task_id})`
      )
    }

    // Carry forward failure_count from prior contexts so the circuit breaker
    // accumulates across retries for the same task.
    const prior = this.db
      .prepare('SELECT MAX(failure_count) as max_failures FROM dispatch_contexts WHERE task_id = ?')
      .get(taskId) as { max_failures: number | null } | undefined
    const priorFailures = prior?.max_failures ?? 0

    const id = generateId('ctx')
    this.db
      .prepare(
        `INSERT INTO dispatch_contexts (id, task_id, coordinator_run_id, assignee_handle, status, failure_count, dispatched_at)
         VALUES (?, ?, ?, ?, 'dispatched', ?, datetime('now'))`
      )
      .run(id, taskId, runId, assigneeHandle, priorFailures)

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

  getActiveDispatchForTerminal(handle: string): DispatchContextRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM dispatch_contexts WHERE assignee_handle = ? AND status IN ('pending', 'dispatched') LIMIT 1"
      )
      .get(handle) as DispatchContextRow | undefined
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
        "UPDATE dispatch_contexts SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
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

  failActiveDispatchForTask(taskId: string, error: string): DispatchContextRow | undefined {
    const active = this.db
      .prepare(
        "SELECT * FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched') ORDER BY rowid DESC LIMIT 1"
      )
      .get(taskId) as DispatchContextRow | undefined
    return active ? this.failDispatch(active.id, error) : undefined
  }

  // Why: only touch rows that are currently dispatched. A straggler heartbeat
  // from a dispatch that already transitioned to `completed` / `failed` /
  // `circuit_broken` MUST NOT retroactively bump `last_heartbeat_at`, because
  // the stale-dispatch detector is the signal the coordinator uses to know a
  // newer dispatch for the same task has hung. Silently no-op'ing keeps the
  // zombie-heartbeat race from masking a hung retry (§5.3.4).
  recordHeartbeat(dispatchId: string, at: string): void {
    this.db
      .prepare(
        "UPDATE dispatch_contexts SET last_heartbeat_at = ? WHERE id = ? AND status = 'dispatched'"
      )
      .run(at, dispatchId)
  }

  // Why: the query restricts to currently-dispatched contexts AND respects a
  // dispatched-at grace. Without `status = 'dispatched'`, every completed /
  // failed / circuit_broken row with an old-or-null last_heartbeat_at would
  // warn every tick (warning storm). Without `dispatched_at < :threshold`,
  // a freshly-dispatched worker would trip the warning during its first
  // heartbeat interval (false positive). Callers supply the threshold as an
  // ISO timestamp so the SQLite string-compare ordering works correctly
  // (ISO-8601 compares lexicographically in time order).
  // Why (#12): `coordinatorRunId` restricts the scan to one run so a
  // coordinator never warns about (or acts on) another run's hung dispatch.
  getStaleDispatches(thresholdIso: string, coordinatorRunId?: string): DispatchContextRow[] {
    const runClause = coordinatorRunId !== undefined ? 'AND coordinator_run_id = ?' : ''
    const params: Database.BindValue[] =
      coordinatorRunId !== undefined
        ? [thresholdIso, thresholdIso, coordinatorRunId]
        : [thresholdIso, thresholdIso]
    return this.db
      .prepare(
        `SELECT * FROM dispatch_contexts
         WHERE status = 'dispatched'
           AND dispatched_at IS NOT NULL
           AND dispatched_at < ?
           AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)
           ${runClause}`
      )
      .all(...params) as DispatchContextRow[]
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
        'UPDATE dispatch_contexts SET status = ?, failure_count = ?, last_failure = ? WHERE id = ?'
      )
      .run(newStatus, newFailureCount, error, ctxId)

    // Why: set the task back to 'ready' (not 'pending') so the coordinator can
    // re-dispatch it on the next tick. The task's deps are already satisfied —
    // setting it to 'pending' would strand it since promoteReadyTasks only runs
    // when a dep completes.
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
    // Why (#12): copy the gated task's run so listGates({status}) stays scoped.
    const runId = this.getTask(gate.taskId)?.coordinator_run_id ?? null
    this.db
      .prepare(
        'INSERT INTO decision_gates (id, task_id, coordinator_run_id, question, options) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, gate.taskId, runId, gate.question, optionsJson)

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

    // Why: unblock the task so the coordinator can re-dispatch it with the
    // resolution context. Setting to 'ready' rather than the previous status
    // because the worker needs to be re-engaged with the decision outcome.
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

  // Why (#12): `coordinatorRunId` scopes status/all listings to one run so a
  // coordinator's processDecisionGates loop never touches another run's gates.
  // A `taskId` filter is already run-implicit (a task belongs to one run).
  listGates(filter?: {
    taskId?: string
    status?: GateStatus
    coordinatorRunId?: string
  }): DecisionGateRow[] {
    const clauses: string[] = []
    const params: Database.BindValue[] = []
    if (filter?.taskId) {
      clauses.push('task_id = ?')
      params.push(filter.taskId)
    }
    if (filter?.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter?.coordinatorRunId !== undefined) {
      clauses.push('coordinator_run_id = ?')
      params.push(filter.coordinatorRunId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.db
      .prepare(`SELECT * FROM decision_gates ${where} ORDER BY created_at`)
      .all(...params) as DecisionGateRow[]
  }

  getGate(id: string): DecisionGateRow | undefined {
    return this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(id) as
      | DecisionGateRow
      | undefined
  }

  // ── Coordinator Runs ──

  createCoordinatorRun(run: CoordinatorRunInsert): CoordinatorRun {
    const id = generateId('run')
    this.db
      .prepare(
        `INSERT INTO coordinator_runs
           (id, spec, status, coordinator_handle, poll_interval_ms, target_key, max_concurrent, worktree_backed, worker_agent)
         VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        run.spec,
        run.coordinatorHandle,
        run.pollIntervalMs ?? 2000,
        run.targetKey ?? null,
        run.maxConcurrent ?? null,
        // Why (#14): store the boolean as 0/1 so a NULL strictly means "pre-v9 /
        // unknown" and resume can tell an explicit legacy run from a missing flag.
        run.worktreeBacked === undefined ? null : run.worktreeBacked ? 1 : 0,
        run.workerAgent ?? null
      )
    return this.db.prepare('SELECT * FROM coordinator_runs WHERE id = ?').get(id) as CoordinatorRun
  }

  // Why (#12): atomic, per-target run-start. The previous flow
  // ("getActiveCoordinatorRun() in the RPC, then createCoordinatorRun") had a
  // TOCTOU window that two runtimes sharing one DB file could both pass,
  // starting two clashing coordinators. BEGIN IMMEDIATE takes the write lock up
  // front, so the check+insert is serialized across connections/processes: the
  // loser sees the winner's running row and gets a CoordinatorRunConflictError.
  // The check is scoped to `target_key` (repo/worktree) so a *duplicate* run on
  // the same target is rejected while Orcastrators in different repos start in
  // parallel. A null target_key (no worktree given at run-start) shares one
  // slot — unidentified targets fall back to single-run. Used by the RPC path;
  // tests/coordinator.run() use the plain createCoordinatorRun insert.
  startCoordinatorRun(run: CoordinatorRunInsert): CoordinatorRun {
    const targetKey = run.targetKey ?? null
    this.db.exec('BEGIN IMMEDIATE')
    let committed = false
    try {
      // `IS ?` so a null target_key matches other null-target running rows.
      const active = this.db
        .prepare(
          "SELECT * FROM coordinator_runs WHERE status = 'running' AND target_key IS ? ORDER BY created_at DESC LIMIT 1"
        )
        .get(targetKey) as CoordinatorRun | undefined
      if (active) {
        throw new CoordinatorRunConflictError(
          `Coordinator already running for this target: ${active.id}`
        )
      }
      const id = generateId('run')
      this.db
        .prepare(
          `INSERT INTO coordinator_runs
             (id, spec, status, coordinator_handle, poll_interval_ms, target_key, max_concurrent, worktree_backed, worker_agent)
           VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          run.spec,
          run.coordinatorHandle,
          run.pollIntervalMs ?? 2000,
          targetKey,
          run.maxConcurrent ?? null,
          run.worktreeBacked === undefined ? null : run.worktreeBacked ? 1 : 0,
          run.workerAgent ?? null
        )
      this.db.exec('COMMIT')
      committed = true
      return this.db
        .prepare('SELECT * FROM coordinator_runs WHERE id = ?')
        .get(id) as CoordinatorRun
    } finally {
      if (!committed) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // No active transaction to roll back — ignore.
        }
      }
    }
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

  // Why (#14): on resume-on-boot, a task left 'dispatched' by the crashed
  // coordinator has a worker that is no longer being monitored (the in-memory
  // coordinator that would receive its worker_done is gone). Leaving it
  // 'dispatched' would never converge — the resumed loop neither re-dispatches it
  // (only 'ready' tasks dispatch) nor times it out (the stale detector only
  // warns). So reclaim each in-flight dispatch through the SAME breaker a live
  // failure uses (failActiveDispatchForTask): the task returns to 'ready' to be
  // re-dispatched into its re-adopted worktree, and the failure strike bounds an
  // infinite restart→resume loop on a poison run (after 3 it converges to
  // 'failed'). Run-scoped so a concurrent run on another target is untouched.
  reclaimInFlightDispatchesForResume(coordinatorRunId: string, reason: string): number {
    const dispatched = this.listTasks({ status: 'dispatched', coordinatorRunId })
    let reclaimed = 0
    for (const task of dispatched) {
      if (this.failActiveDispatchForTask(task.id, reason)) {
        reclaimed++
      }
    }
    return reclaimed
  }

  // Why (F3 #14): an atomic, boot-time-fenced claim so only ONE runtime drives a
  // resumed run when two share a DB file (desktop + `orca serve`). `fenceIso` is the
  // claiming runtime's boot time. The claim wins iff the run is still 'running' and
  // is unclaimed OR holds a STRICTLY-OLDER fence (a prior, now-dead resumer). Two
  // runtimes booting together share a fence, so the strict `<` lets exactly one win
  // (the other sees the just-written equal fence and loses) — no double-drive. A
  // later boot's larger fence reclaims a crashed resumer's stale claim, so a crash
  // mid-resume can't strand the run. BEGIN IMMEDIATE serializes the check+set across
  // processes. Store ISO (not datetime('now')) so it lexically compares with fenceIso.
  tryClaimRunForResume(runId: string, fenceIso: string): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    let committed = false
    try {
      const info = this.db
        .prepare(
          `UPDATE coordinator_runs SET resumed_at = ?
             WHERE id = ?
               AND status = 'running'
               AND (resumed_at IS NULL OR resumed_at < ?)`
        )
        .run(fenceIso, runId, fenceIso)
      this.db.exec('COMMIT')
      committed = true
      return Number((info as { changes?: number | bigint }).changes ?? 0) === 1
    } finally {
      if (!committed) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // No active transaction to roll back — ignore.
        }
      }
    }
  }

  getActiveCoordinatorRun(): CoordinatorRun | undefined {
    return this.db
      .prepare(
        "SELECT * FROM coordinator_runs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as CoordinatorRun | undefined
  }

  // Why (#12): the active run *for a specific target*. taskCreate uses this to
  // stamp a mid-run task with the run on its OWN target — never the global
  // latest-running run, which under concurrency could belong to a different
  // target and would poach the task. `IS ?` so a null target matches the
  // null-slot run.
  getActiveCoordinatorRunForTarget(targetKey: string | null): CoordinatorRun | undefined {
    return this.db
      .prepare(
        "SELECT * FROM coordinator_runs WHERE status = 'running' AND target_key IS ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(targetKey) as CoordinatorRun | undefined
  }

  // Why: getActiveCoordinatorRun returns only the latest. Per-Orcastrator
  // background-activity attribution needs every still-running run so each one
  // can be keyed to its own coordinator's pane.
  listCoordinatorRuns(filter?: { status?: CoordinatorStatus }): CoordinatorRun[] {
    if (filter?.status) {
      return this.db
        .prepare('SELECT * FROM coordinator_runs WHERE status = ? ORDER BY created_at')
        .all(filter.status) as CoordinatorRun[]
    }
    return this.db
      .prepare('SELECT * FROM coordinator_runs ORDER BY created_at')
      .all() as CoordinatorRun[]
  }

  // Why: cheap counts for the supervision dot — outstanding work means tasks
  // not yet in a terminal state (pending/ready/dispatched/blocked).
  countOutstandingTasks(coordinatorRunId?: string): number {
    const runClause = coordinatorRunId !== undefined ? 'AND coordinator_run_id = ?' : ''
    const params: Database.BindValue[] = coordinatorRunId !== undefined ? [coordinatorRunId] : []
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks WHERE status IN ('pending', 'ready', 'dispatched', 'blocked') ${runClause}`
      )
      .get(...params) as { n: number }
    return row.n
  }

  // Why: a worker is still busy while its dispatch is pending or dispatched.
  // `coordinatorRunId` scopes the count to one run (#12); omit for a global tally.
  countActiveDispatches(coordinatorRunId?: string): number {
    const runClause = coordinatorRunId !== undefined ? 'AND coordinator_run_id = ?' : ''
    const params: Database.BindValue[] = coordinatorRunId !== undefined ? [coordinatorRunId] : []
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM dispatch_contexts WHERE status IN ('pending', 'dispatched') ${runClause}`
      )
      .get(...params) as { n: number }
    return row.n
  }

  // ── Lifecycle ──

  resetAll(): void {
    this.db.exec('DELETE FROM coordinator_runs')
    this.db.exec('DELETE FROM decision_gates')
    this.db.exec('DELETE FROM dispatch_contexts')
    this.db.exec('DELETE FROM tasks')
    this.db.exec('DELETE FROM messages')
  }

  resetTasks(): void {
    this.db.exec('DELETE FROM coordinator_runs')
    this.db.exec('DELETE FROM decision_gates')
    this.db.exec('DELETE FROM dispatch_contexts')
    this.db.exec('DELETE FROM tasks')
  }

  resetMessages(): void {
    this.db.exec('DELETE FROM messages')
  }

  close(): void {
    this.db.close()
  }
}
