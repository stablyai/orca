/* eslint-disable max-lines -- Why: the orchestration DB keeps schema creation, message CRUD, task DAG resolution, and dispatch context management in one class so transactional invariants (e.g. promoteReadyTasks running inside the same writer as updateTaskStatus) are enforced by locality. */
import { randomBytes } from 'node:crypto'
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
import { parsePaneKey } from '../../../shared/stable-pane-id'

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
  CoordinatorRun
}

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

function addLifecycleRejectionMarker(payload: string | null, reason: string): string {
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
    _orcaLifecycleRejection: { code: 'sender_not_assignee', reason }
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

// Schema versions: v2 'heartbeat'+last_heartbeat_at, v3 delivered_at, v4 task-creator terminal, v5 task_title/display_name, v6 pane-identity columns.
const SCHEMA_VERSION = 6

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
        delivered_at  TEXT,
        sender_pane_key TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
      CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_handle, read);
      CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id);

      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
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
        task_id             TEXT NOT NULL,
        assignee_handle     TEXT,
        assignee_pane_key   TEXT,
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

  // Why: CREATE TABLE IF NOT EXISTS won't alter existing DBs; migrate in a txn that bumps user_version only on success (atomic all-or-nothing).
  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number
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
    senderPaneKey?: string
  }): MessageRow {
    const id = generateId('msg')
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, from_handle, to_handle, subject, body, type, priority, thread_id, payload, sender_pane_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  convertLifecycleMessageToRejection(messageId: string, reason: string): MessageRow | undefined {
    const message = this.getMessageById(messageId)
    if (!message || (message.type !== 'worker_done' && message.type !== 'heartbeat')) {
      return message
    }

    const originalBody = message.body ? `\n\nOriginal body:\n${message.body}` : ''
    const body = `Orca rejected this ${message.type}: ${reason}${originalBody}`
    const payload = addLifecycleRejectionMarker(message.payload, reason)
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

  // ── Tasks ──

  createTask(task: {
    spec: string
    taskTitle?: string
    displayName?: string
    deps?: string[]
    parentId?: string
    createdByTerminalHandle?: string
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
        'INSERT INTO tasks (id, parent_id, created_by_terminal_handle, task_title, display_name, spec, status, deps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
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

  // Why: LEFT JOIN keeps non-dispatched tasks (NULL assignee); the MAX(rowid) subquery matches getDispatchContext's most-recent-active-dispatch semantics.
  listTasksWithDispatch(filter?: { status?: TaskStatus; ready?: boolean }): (TaskRow & {
    assignee_handle: string | null
    dispatch_id: string | null
  })[] {
    const whereClauses: string[] = []
    const params: Database.BindValue[] = []
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
        `INSERT INTO dispatch_contexts (id, task_id, assignee_handle, assignee_pane_key, status, failure_count, dispatched_at)
         VALUES (?, ?, ?, ?, 'dispatched', ?, datetime('now'))`
      )
      .run(id, taskId, assigneeHandle, assigneePaneKey ?? null, priorFailures)
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
        'UPDATE dispatch_contexts SET status = ?, failure_count = ?, last_failure = ? WHERE id = ?'
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

  resetAll(): void {
    this.db.exec('DELETE FROM coordinator_runs')
    this.db.exec('DELETE FROM decision_gates')
    this.db.exec('DELETE FROM dispatch_contexts')
    this.db.exec('DELETE FROM tasks')
    this.db.exec('DELETE FROM messages')
    this.hasAnyDispatchContextsCache = undefined
  }

  resetTasks(): void {
    this.db.exec('DELETE FROM coordinator_runs')
    this.db.exec('DELETE FROM decision_gates')
    this.db.exec('DELETE FROM dispatch_contexts')
    this.db.exec('DELETE FROM tasks')
    this.hasAnyDispatchContextsCache = undefined
  }

  resetMessages(): void {
    this.db.exec('DELETE FROM messages')
  }

  close(): void {
    this.db.close()
  }
}
