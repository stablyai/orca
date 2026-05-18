/* eslint-disable max-lines -- Why: the orchestration DB keeps schema creation, message CRUD, task DAG resolution, and dispatch context management in one class so transactional invariants (e.g. promoteReadyTasks running inside the same writer as updateTaskStatus) are enforced by locality. */
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
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

// Why: v1 → v2 added `'heartbeat'` to messages.type CHECK + `last_heartbeat_at`
// column (preamble-hardening PR). v2 → v3 adds `delivered_at` column so
// push-on-idle can distinguish queued-but-undelivered from user-acknowledged
// messages without touching the `read` bit (check-wait PR). v3 → v4 records
// the terminal that created a task so task-record worktree creation can infer
// the parent workspace even when no dispatch context exists.
const SCHEMA_VERSION = 4

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
  getAllMessagesForHandle(toHandle: string, limit = 100): MessageRow[] {
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
    deps?: string[]
    parentId?: string
    createdByTerminalHandle?: string
  }): TaskRow {
    const id = generateId('task')
    const depsJson = JSON.stringify(task.deps ?? [])
    const hasDeps = (task.deps ?? []).length > 0
    const status: TaskStatus = hasDeps ? 'pending' : 'ready'
    this.db
      .prepare(
        'INSERT INTO tasks (id, parent_id, created_by_terminal_handle, spec, status, deps) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        task.parentId ?? null,
        task.createdByTerminalHandle ?? null,
        task.spec,
        status,
        depsJson
      )
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  }

  listTasks(filter?: { status?: TaskStatus; ready?: boolean }): TaskRow[] {
    if (filter?.ready) {
      return this.db
        .prepare("SELECT * FROM tasks WHERE status = 'ready' ORDER BY created_at")
        .all() as TaskRow[]
    }
    if (filter?.status) {
      return this.db
        .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at')
        .all(filter.status) as TaskRow[]
    }
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as TaskRow[]
  }

  // Why: surfaces the active dispatch (assignee handle + dispatch context id)
  // alongside each task so coordinators can answer "who is working on task X?"
  // from a single query. The LEFT JOIN keeps non-dispatched tasks in the result
  // with NULL assignee/dispatch fields so non-dispatched output stays stable.
  // The inner subquery picks the most recent active dispatch per task to match
  // the semantics of getDispatchContext for dispatched tasks.
  listTasksWithDispatch(filter?: { status?: TaskStatus; ready?: boolean }): (TaskRow & {
    assignee_handle: string | null
    dispatch_id: string | null
  })[] {
    const whereClauses: string[] = []
    const params: unknown[] = []
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

  // Why: when a task completes, check if any pending tasks that depended on it
  // now have all deps satisfied. If so, promote them to 'ready'. This is the
  // DAG resolution step — it runs synchronously inside the same transaction as
  // the status update, so there's no window where a task is completable but its
  // children haven't been promoted.
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

  createDispatchContext(taskId: string, assigneeHandle: string): DispatchContextRow {
    const task = this.getTask(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }
    if (task.status !== 'ready') {
      throw new Error(`Task ${taskId} is ${task.status}; only ready tasks can be dispatched`)
    }

    const existing = this.db
      .prepare(
        "SELECT * FROM dispatch_contexts WHERE assignee_handle = ? AND status IN ('pending', 'dispatched')"
      )
      .get(assigneeHandle) as DispatchContextRow | undefined

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
        `INSERT INTO dispatch_contexts (id, task_id, assignee_handle, status, failure_count, dispatched_at)
         VALUES (?, ?, ?, 'dispatched', ?, datetime('now'))`
      )
      .run(id, taskId, assigneeHandle, priorFailures)

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

  getActiveDispatchForTerminal(handle: string): DispatchContextRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM dispatch_contexts WHERE assignee_handle = ? AND status IN ('pending', 'dispatched') LIMIT 1"
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
  getStaleDispatches(thresholdIso: string): DispatchContextRow[] {
    return this.db
      .prepare(
        `SELECT * FROM dispatch_contexts
         WHERE status = 'dispatched'
           AND dispatched_at IS NOT NULL
           AND dispatched_at < ?
           AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)`
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
    this.db
      .prepare('INSERT INTO decision_gates (id, task_id, question, options) VALUES (?, ?, ?, ?)')
      .run(id, gate.taskId, gate.question, optionsJson)

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
    // Why: returns terminal handles that have no active dispatch, so the
    // coordinator knows which terminals are available for new task assignments.
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
