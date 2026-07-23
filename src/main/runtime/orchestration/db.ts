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
import {
  assertOrchestrationStringListFits,
  assertOrchestrationWriteFits,
  clampOrchestrationQueryLimit,
  ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES,
  ORCHESTRATION_QUERY_MAX_ROWS,
  ORCHESTRATION_WRITE_MAX_ITEMS,
  parseOrchestrationJson,
  retainOrchestrationQueryRows,
  truncateOrchestrationDiagnostic
} from './query-retention'

function retainedTextBytesSql(columns: string[]): string {
  return columns.map((column) => `length(CAST(COALESCE(${column}, '') AS BLOB))`).join(' + ')
}

const MESSAGE_ROW_BYTES_SQL = retainedTextBytesSql([
  'messages.id',
  'messages.from_handle',
  'messages.to_handle',
  'messages.subject',
  'messages.body',
  'messages.type',
  'messages.priority',
  'messages.thread_id',
  'messages.payload',
  'messages.created_at',
  'messages.delivered_at',
  'messages.sender_pane_key'
])
const TASK_ROW_BYTES_SQL = retainedTextBytesSql([
  'tasks.id',
  'tasks.parent_id',
  'tasks.created_by_terminal_handle',
  'tasks.task_title',
  'tasks.display_name',
  'tasks.spec',
  'tasks.status',
  'tasks.deps',
  'tasks.result',
  'tasks.created_at',
  'tasks.completed_at'
])
const DISPATCH_ROW_BYTES_SQL = retainedTextBytesSql([
  'dispatch_contexts.id',
  'dispatch_contexts.task_id',
  'dispatch_contexts.assignee_handle',
  'dispatch_contexts.assignee_pane_key',
  'dispatch_contexts.status',
  'dispatch_contexts.last_failure',
  'dispatch_contexts.dispatched_at',
  'dispatch_contexts.completed_at',
  'dispatch_contexts.created_at',
  'dispatch_contexts.last_heartbeat_at'
])
const GATE_ROW_BYTES_SQL = retainedTextBytesSql([
  'decision_gates.id',
  'decision_gates.task_id',
  'decision_gates.question',
  'decision_gates.options',
  'decision_gates.status',
  'decision_gates.resolution',
  'decision_gates.created_at',
  'decision_gates.resolved_at'
])
const COORDINATOR_RUN_ROW_BYTES_SQL = retainedTextBytesSql([
  'coordinator_runs.id',
  'coordinator_runs.spec',
  'coordinator_runs.status',
  'coordinator_runs.coordinator_handle',
  'coordinator_runs.created_at',
  'coordinator_runs.completed_at'
])
const INTERNAL_SCAN_BATCH_ROWS = 64

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

export type TaskStatusCounts = Record<TaskStatus, number> & { total: number }

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

function uniqueMessageTypes(types: MessageType[] | undefined): MessageType[] {
  const unique: MessageType[] = []
  for (const type of types ?? []) {
    if (!unique.includes(type)) {
      unique.push(type)
      if (unique.length === 8) {
        break
      }
    }
  }
  return unique
}

function addLifecycleRejectionMarker(payload: string | null, reason: string): string {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = payload ? parseOrchestrationJson(payload) : {}
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

  private readRows<T extends object>(
    sql: string,
    params: Database.BindValue[] = [],
    requestedLimit?: number
  ): T[] {
    const limit = clampOrchestrationQueryLimit(requestedLimit)
    if (limit === 0) {
      return []
    }
    const rows = this.db.prepare(`${sql} LIMIT ?`).iterate(...params, limit) as Iterable<T>
    return retainOrchestrationQueryRows(rows, limit)
  }

  private countRows(sql: string, params: Database.BindValue[] = []): number {
    const row = this.db.prepare(sql).get(...params) as { count: number }
    return row.count
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
    assertOrchestrationWriteFits('Message', [
      msg.from,
      msg.to,
      msg.subject,
      msg.body,
      msg.type,
      msg.priority,
      msg.threadId,
      msg.payload,
      msg.senderPaneKey
    ])
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
    return this.getMessageById(id)!
  }

  getUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    const params: Database.BindValue[] = [toHandle]
    let typeFilter = ''
    const retainedTypes = uniqueMessageTypes(types)
    if (retainedTypes.length > 0) {
      const placeholders = retainedTypes.map(() => '?').join(',')
      typeFilter = ` AND type IN (${placeholders})`
      params.push(...retainedTypes)
    }
    return exposeMessageListTimestamps(
      this.readRows<MessageRow>(
        `SELECT * FROM messages
         WHERE to_handle = ? AND read = 0${typeFilter}
           AND (${MESSAGE_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         ORDER BY sequence`,
        params
      )
    )
  }

  countUnreadMessages(toHandle: string, types?: MessageType[]): number {
    const retainedTypes = uniqueMessageTypes(types)
    const placeholders = retainedTypes.map(() => '?').join(',')
    const typeFilter = retainedTypes.length > 0 ? ` AND type IN (${placeholders})` : ''
    return this.countRows(
      `SELECT COUNT(*) AS count FROM messages
       WHERE to_handle = ? AND read = 0${typeFilter}`,
      [toHandle, ...retainedTypes]
    )
  }

  convertLifecycleMessageToRejection(messageId: string, reason: string): MessageRow | undefined {
    const message = this.getMessageById(messageId)
    if (!message || (message.type !== 'worker_done' && message.type !== 'heartbeat')) {
      return message
    }

    const originalBody = message.body ? `\n\nOriginal body:\n${message.body}` : ''
    const boundedReason = truncateOrchestrationDiagnostic(reason)
    const body = truncateOrchestrationDiagnostic(
      `Orca rejected this ${message.type}: ${boundedReason}${originalBody}`
    )
    const payload = addLifecycleRejectionMarker(message.payload, boundedReason)
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
    const params: Database.BindValue[] = [toHandle]
    let typeFilter = ''
    const retainedTypes = uniqueMessageTypes(types)
    if (retainedTypes.length > 0) {
      const placeholders = retainedTypes.map(() => '?').join(',')
      typeFilter = ` AND type IN (${placeholders})`
      params.push(...retainedTypes)
    }
    return exposeMessageListTimestamps(
      this.readRows<MessageRow>(
        `SELECT * FROM messages
         WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL${typeFilter}
           AND (${MESSAGE_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         ORDER BY sequence`,
        params
      )
    )
  }

  getAllMessages(toHandle: string, limit = 20): MessageRow[] {
    return exposeMessageListTimestamps(
      this.readRows<MessageRow>(
        `SELECT * FROM messages
         WHERE to_handle = ?
           AND (${MESSAGE_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         ORDER BY sequence DESC`,
        [toHandle],
        limit
      )
    )
  }

  getMessageById(id: string): MessageRow | undefined {
    const message = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE id = ? AND (${MESSAGE_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}`
      )
      .get(id) as MessageRow | undefined
    return message ? exposeMessageTimestamps(message) : undefined
  }

  markAsRead(ids: string[]): void {
    this.updateMessageIds(ids, 'read = 1')
  }

  // Why: use datetime('now') so delivered_at matches the space-format UTC shape of the table's other timestamps for correct ordering (§3.2).
  markAsDelivered(ids: string[]): void {
    this.updateMessageIds(ids, "delivered_at = datetime('now')")
  }

  markAsReadAndDelivered(ids: string[]): void {
    // Why: superseded lifecycle messages stay in history but must not be consumed or injected after their dispatch finished.
    this.updateMessageIds(ids, "read = 1, delivered_at = COALESCE(delivered_at, datetime('now'))")
  }

  private updateMessageIds(ids: string[], assignments: string): void {
    for (let start = 0; start < ids.length; start += ORCHESTRATION_QUERY_MAX_ROWS) {
      const batch = ids.slice(start, start + ORCHESTRATION_QUERY_MAX_ROWS)
      const placeholders = batch.map(() => '?').join(',')
      this.db
        .prepare(`UPDATE messages SET ${assignments} WHERE id IN (${placeholders})`)
        .run(...batch)
    }
  }

  getInbox(limit = 20): MessageRow[] {
    return exposeMessageListTimestamps(
      this.readRows<MessageRow>(
        `SELECT * FROM messages
         WHERE (${MESSAGE_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         ORDER BY sequence DESC`,
        [],
        limit
      )
    )
  }

  countInbox(): number {
    return this.countRows('SELECT COUNT(*) AS count FROM messages')
  }

  // Why: read-only history for a handle — returns every message regardless of read/delivered state, never flips the read bit (§3.3).
  getAllMessagesForHandle(toHandle: string, limit = 100, types?: MessageType[]): MessageRow[] {
    const params: Database.BindValue[] = [toHandle]
    let typeFilter = ''
    const retainedTypes = uniqueMessageTypes(types)
    if (retainedTypes.length > 0) {
      const placeholders = retainedTypes.map(() => '?').join(',')
      typeFilter = ` AND type IN (${placeholders})`
      params.push(...retainedTypes)
    }
    return exposeMessageListTimestamps(
      this.readRows<MessageRow>(
        `SELECT * FROM messages
         WHERE to_handle = ?${typeFilter}
           AND (${MESSAGE_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         ORDER BY sequence DESC`,
        params,
        limit
      )
    )
  }

  countAllMessagesForHandle(toHandle: string, types?: MessageType[]): number {
    const retainedTypes = uniqueMessageTypes(types)
    const placeholders = retainedTypes.map(() => '?').join(',')
    const typeFilter = retainedTypes.length > 0 ? ` AND type IN (${placeholders})` : ''
    return this.countRows(
      `SELECT COUNT(*) AS count FROM messages WHERE to_handle = ?${typeFilter}`,
      [toHandle, ...retainedTypes]
    )
  }

  // Why: ask wait-loop read — to_handle filter shows only replies to the worker; afterSequence resumes past its own outbound ask.
  getThreadMessagesFor(threadId: string, toHandle: string, afterSequence?: number): MessageRow[] {
    const sequenceFilter = afterSequence === undefined ? '' : ' AND sequence > ?'
    const params: Database.BindValue[] =
      afterSequence === undefined ? [threadId, toHandle] : [threadId, toHandle, afterSequence]
    return exposeMessageListTimestamps(
      this.readRows<MessageRow>(
        `SELECT * FROM messages
         WHERE thread_id = ? AND to_handle = ?${sequenceFilter}
           AND (${MESSAGE_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         ORDER BY sequence ASC`,
        params
      )
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
    const deps = task.deps ?? []
    assertOrchestrationStringListFits('Task dependencies', deps)
    assertOrchestrationWriteFits('Task', [
      task.spec,
      task.taskTitle,
      task.displayName,
      task.parentId,
      task.createdByTerminalHandle,
      ...deps
    ])
    const depsJson = JSON.stringify(deps)
    const hasDeps = deps.length > 0
    const status: TaskStatus = hasDeps ? 'pending' : 'ready'
    const display = buildOrchestrationTaskDisplayMetadata({
      spec: task.spec,
      taskTitle: task.taskTitle,
      displayName: task.displayName
    })
    assertOrchestrationWriteFits('Task', [
      task.spec,
      display.taskTitle,
      display.displayName,
      depsJson,
      task.parentId,
      task.createdByTerminalHandle
    ])
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
    return this.getTask(id)!
  }

  getTask(id: string): TaskRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE id = ? AND (${TASK_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}`
      )
      .get(id) as TaskRow | undefined
  }

  listTasks(filter?: { status?: TaskStatus; ready?: boolean }): TaskRow[] {
    const status = filter?.ready ? 'ready' : filter?.status
    const statusFilter = status ? 'status = ? AND ' : ''
    return this.readRows<TaskRow>(
      `SELECT * FROM tasks
       WHERE ${statusFilter}(${TASK_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
       ORDER BY created_at, rowid`,
      status ? [status] : []
    )
  }

  countTasks(filter?: { status?: TaskStatus; ready?: boolean }): number {
    const status = filter?.ready ? 'ready' : filter?.status
    return this.countRows(
      `SELECT COUNT(*) AS count FROM tasks${status ? ' WHERE status = ?' : ''}`,
      status ? [status] : []
    )
  }

  // Why: LEFT JOIN keeps non-dispatched tasks (NULL assignee); the MAX(rowid) subquery matches getDispatchContext's most-recent-active-dispatch semantics.
  listTasksWithDispatch(filter?: { status?: TaskStatus; ready?: boolean }): (TaskRow & {
    assignee_handle: string | null
    dispatch_id: string | null
  })[] {
    const whereClauses: string[] = []
    const params: Database.BindValue[] = []
    if (filter?.ready) {
      whereClauses.push("tasks.status = 'ready'")
    } else if (filter?.status) {
      whereClauses.push('tasks.status = ?')
      params.push(filter.status)
    }
    whereClauses.push(
      `(${TASK_ROW_BYTES_SQL}
        + length(CAST(COALESCE(d.assignee_handle, '') AS BLOB))
        + length(CAST(COALESCE(d.id, '') AS BLOB))) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}`
    )
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''
    const sql = `
      SELECT
        tasks.*,
        d.assignee_handle AS assignee_handle,
        d.id              AS dispatch_id
      FROM tasks
      LEFT JOIN (
        SELECT dc.id, dc.task_id, dc.assignee_handle
        FROM dispatch_contexts dc
        INNER JOIN (
          SELECT task_id, MAX(rowid) AS max_rowid
          FROM dispatch_contexts
          WHERE status IN ('pending', 'dispatched')
          GROUP BY task_id
        ) latest ON latest.task_id = dc.task_id AND latest.max_rowid = dc.rowid
      ) d ON d.task_id = tasks.id
      ${where}
      ORDER BY tasks.created_at, tasks.rowid
    `
    return this.readRows<
      TaskRow & {
        assignee_handle: string | null
        dispatch_id: string | null
      }
    >(sql, params) as (TaskRow & {
      assignee_handle: string | null
      dispatch_id: string | null
    })[]
  }

  updateTaskStatus(id: string, status: TaskStatus, result?: string): TaskRow | undefined {
    assertOrchestrationWriteFits('Task result', [result])
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
    let afterRowId = 0
    while (true) {
      const candidates = this.readRows<{ rowid: number; id: string; deps: string }>(
        `SELECT rowid, id, deps FROM tasks
         WHERE status = 'pending' AND rowid > ?
           AND (${retainedTextBytesSql(['tasks.id', 'tasks.deps'])})
             <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
           AND CASE WHEN json_valid(deps)
             THEN json_type(deps) = 'array'
               AND json_array_length(deps) <= ${ORCHESTRATION_WRITE_MAX_ITEMS}
             ELSE 0
           END
         ORDER BY rowid`,
        [afterRowId],
        INTERNAL_SCAN_BATCH_ROWS
      )
      if (candidates.length === 0) {
        return
      }
      afterRowId = candidates.at(-1)!.rowid

      for (const task of candidates) {
        let parsedDeps: unknown
        try {
          parsedDeps = parseOrchestrationJson(task.deps)
        } catch {
          continue
        }
        if (
          !Array.isArray(parsedDeps) ||
          parsedDeps.length > ORCHESTRATION_WRITE_MAX_ITEMS ||
          !parsedDeps.every((dependency) => typeof dependency === 'string')
        ) {
          continue
        }
        const deps = parsedDeps
        if (!deps.includes(completedTaskId)) {
          continue
        }
        const allDepsCompleted = deps.every((depId) => this.getTask(depId)?.status === 'completed')
        if (allDepsCompleted) {
          this.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
        }
      }
    }
  }

  getTaskStatusCounts(): TaskStatusCounts {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(status = 'pending'), 0) AS pending,
           COALESCE(SUM(status = 'ready'), 0) AS ready,
           COALESCE(SUM(status = 'dispatched'), 0) AS dispatched,
           COALESCE(SUM(status = 'completed'), 0) AS completed,
           COALESCE(SUM(status = 'failed'), 0) AS failed,
           COALESCE(SUM(status = 'blocked'), 0) AS blocked
         FROM tasks`
      )
      .get() as TaskStatusCounts
    return row
  }

  listTaskIdsByStatus(status: TaskStatus): string[] {
    const rows = this.readRows<{ id: string }>(
      `SELECT id FROM tasks
       WHERE status = ?
         AND length(CAST(id AS BLOB)) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
       ORDER BY created_at, rowid`,
      [status]
    )
    return rows.map((row) => row.id)
  }

  // ── Dispatch Contexts ──

  createDispatchContext(
    taskId: string,
    assigneeHandle: string,
    // Why: pane key is the remint-stable identity behind the handle — lets worker_done ownership survive handle reissue.
    assigneePaneKey?: string
  ): DispatchContextRow {
    assertOrchestrationWriteFits('Dispatch context', [taskId, assigneeHandle, assigneePaneKey])
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

    return this.getDispatchContextById(id)!
  }

  getDispatchContext(taskId: string): DispatchContextRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM dispatch_contexts
         WHERE task_id = ?
           AND (${DISPATCH_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         ORDER BY rowid DESC LIMIT 1`
      )
      .get(taskId) as DispatchContextRow | undefined
  }

  getDispatchContextById(dispatchId: string): DispatchContextRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM dispatch_contexts
         WHERE id = ?
           AND (${DISPATCH_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}`
      )
      .get(dispatchId) as DispatchContextRow | undefined
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
        `SELECT * FROM dispatch_contexts
         WHERE assignee_handle = ? AND status IN ('pending', 'dispatched')
           AND (${DISPATCH_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         LIMIT 1`
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
        `SELECT id, assignee_pane_key FROM dispatch_contexts
         WHERE assignee_pane_key IS NOT NULL AND status IN ('pending', 'dispatched')
           AND (${retainedTextBytesSql([
             'dispatch_contexts.id',
             'dispatch_contexts.assignee_pane_key'
           ])}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         ORDER BY rowid`
      )
      .iterate() as Iterable<{ id: string; assignee_pane_key: string }>

    let matchingId: string | undefined
    for (const row of actives) {
      if (isEquivalentPaneKey(row.assignee_pane_key, assigneePaneKey)) {
        matchingId = row.id
        break
      }
    }
    return matchingId ? this.getDispatchContextById(matchingId) : undefined
  }

  getLatestDispatchForTerminal(handle: string): DispatchContextRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM dispatch_contexts
         WHERE assignee_handle = ?
           AND (${DISPATCH_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         ORDER BY rowid DESC LIMIT 1`
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
        "SELECT id FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched') ORDER BY rowid DESC LIMIT 1"
      )
      .get(taskId) as { id: string } | undefined
    if (active) {
      this.completeDispatch(active.id)
    }
  }

  failActiveDispatchForTask(taskId: string, error: string): DispatchContextRow | undefined {
    const active = this.db
      .prepare(
        "SELECT id FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched') ORDER BY rowid DESC LIMIT 1"
      )
      .get(taskId) as { id: string } | undefined
    return active ? this.failDispatch(active.id, error) : undefined
  }

  // Why: only bump status='dispatched' — a zombie heartbeat from a finished dispatch would mask a hung retry from the stale detector (§5.3.4).
  recordHeartbeat(dispatchId: string, at: string): void {
    assertOrchestrationWriteFits('Dispatch heartbeat', [dispatchId, at])
    this.db
      .prepare(
        "UPDATE dispatch_contexts SET last_heartbeat_at = ? WHERE id = ? AND status = 'dispatched'"
      )
      .run(at, dispatchId)
  }

  // Why: dispatched_at grace skips workers still within their first heartbeat interval; julianday() vs raw-TEXT compare avoids misflagging space-format timestamps as stale (#8452).
  getStaleDispatches(thresholdIso: string): DispatchContextRow[] {
    return this.readRows<DispatchContextRow>(
      `SELECT * FROM dispatch_contexts
       WHERE status = 'dispatched'
         AND dispatched_at IS NOT NULL
         AND julianday(dispatched_at) < julianday(?)
         AND (last_heartbeat_at IS NULL OR julianday(last_heartbeat_at) < julianday(?))
         AND (${DISPATCH_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
       ORDER BY rowid`,
      [thresholdIso, thresholdIso]
    )
  }

  forEachStaleDispatch(thresholdIso: string, visit: (row: DispatchContextRow) => void): void {
    const rows = this.db
      .prepare(
        `SELECT * FROM dispatch_contexts
         WHERE status = 'dispatched'
           AND dispatched_at IS NOT NULL
           AND julianday(dispatched_at) < julianday(?)
           AND (last_heartbeat_at IS NULL OR julianday(last_heartbeat_at) < julianday(?))
           AND (${DISPATCH_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         ORDER BY rowid`
      )
      .iterate(thresholdIso, thresholdIso) as Iterable<DispatchContextRow>
    for (const row of rows) {
      visit(row)
    }
  }

  failDispatch(ctxId: string, error: string): DispatchContextRow | undefined {
    const ctx = this.getDispatchContextById(ctxId)
    if (!ctx) {
      return undefined
    }

    const newFailureCount = ctx.failure_count + 1
    const newStatus: DispatchStatus = newFailureCount >= 3 ? 'circuit_broken' : 'failed'

    this.db
      .prepare(
        'UPDATE dispatch_contexts SET status = ?, failure_count = ?, last_failure = ? WHERE id = ?'
      )
      .run(newStatus, newFailureCount, truncateOrchestrationDiagnostic(error), ctxId)

    // Why: back to 'ready' not 'pending' — 'pending' would strand it since promoteReadyTasks only runs when a dep completes.
    const taskStatus: TaskStatus = newStatus === 'circuit_broken' ? 'failed' : 'ready'
    this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(taskStatus, ctx.task_id)

    return this.getDispatchContextById(ctxId)
  }

  // ── Decision Gates ──

  createGate(gate: { taskId: string; question: string; options?: string[] }): DecisionGateRow {
    const id = generateId('gate')
    const options = gate.options ?? []
    assertOrchestrationStringListFits('Decision gate options', options)
    assertOrchestrationWriteFits('Decision gate', [gate.taskId, gate.question, ...options])
    const optionsJson = JSON.stringify(options)
    assertOrchestrationWriteFits('Decision gate', [gate.taskId, gate.question, optionsJson])
    this.db
      .prepare('INSERT INTO decision_gates (id, task_id, question, options) VALUES (?, ?, ?, ?)')
      .run(id, gate.taskId, gate.question, optionsJson)

    this.completeActiveDispatchForTask(gate.taskId)
    this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(gate.taskId)

    return this.getGate(id)!
  }

  resolveGate(gateId: string, resolution: string): DecisionGateRow | undefined {
    assertOrchestrationWriteFits('Decision gate resolution', [gateId, resolution])
    const gate = this.getGate(gateId)
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

    return this.getGate(gateId)
  }

  timeoutGate(gateId: string): DecisionGateRow | undefined {
    this.db
      .prepare(
        "UPDATE decision_gates SET status = 'timeout', resolved_at = datetime('now') WHERE id = ?"
      )
      .run(gateId)
    return this.getGate(gateId)
  }

  listGates(filter?: { taskId?: string; status?: GateStatus }): DecisionGateRow[] {
    const clauses = [`(${GATE_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}`]
    const params: Database.BindValue[] = []
    if (filter?.taskId && filter?.status) {
      clauses.push('task_id = ?', 'status = ?')
      params.push(filter.taskId, filter.status)
    } else if (filter?.taskId) {
      clauses.push('task_id = ?')
      params.push(filter.taskId)
    } else if (filter?.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    return this.readRows<DecisionGateRow>(
      `SELECT * FROM decision_gates
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at, rowid`,
      params
    )
  }

  countGates(filter?: { taskId?: string; status?: GateStatus }): number {
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
    return this.countRows(
      `SELECT COUNT(*) AS count FROM decision_gates${
        clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
      }`,
      params
    )
  }

  getGate(id: string): DecisionGateRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM decision_gates
         WHERE id = ? AND (${GATE_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}`
      )
      .get(id) as DecisionGateRow | undefined
  }

  getLatestGate(filter: { taskId: string; status: GateStatus }): DecisionGateRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM decision_gates
         WHERE task_id = ? AND status = ?
           AND (${GATE_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(filter.taskId, filter.status) as DecisionGateRow | undefined
  }

  restorePendingGateTaskStatuses(): void {
    this.db
      .prepare(
        `UPDATE tasks SET status = 'blocked'
         WHERE status <> 'blocked'
           AND EXISTS (
             SELECT 1 FROM decision_gates
             WHERE decision_gates.task_id = tasks.id
               AND decision_gates.status = 'pending'
           )`
      )
      .run()
  }

  // ── Coordinator Runs ──

  createCoordinatorRun(run: {
    spec: string
    coordinatorHandle: string
    pollIntervalMs?: number
  }): CoordinatorRun {
    assertOrchestrationWriteFits('Coordinator run', [run.spec, run.coordinatorHandle])
    const id = generateId('run')
    this.db
      .prepare(
        "INSERT INTO coordinator_runs (id, spec, status, coordinator_handle, poll_interval_ms) VALUES (?, ?, 'running', ?, ?)"
      )
      .run(id, run.spec, run.coordinatorHandle, run.pollIntervalMs ?? 2000)
    return this.getCoordinatorRun(id)!
  }

  getCoordinatorRun(id: string): CoordinatorRun | undefined {
    return this.db
      .prepare(
        `SELECT * FROM coordinator_runs
         WHERE id = ?
           AND (${COORDINATOR_RUN_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}`
      )
      .get(id) as CoordinatorRun | undefined
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
        `SELECT * FROM coordinator_runs
         WHERE status = 'running'
           AND (${COORDINATOR_RUN_ROW_BYTES_SQL}) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get() as CoordinatorRun | undefined
  }

  // ── Queries for Coordinator ──

  getIdleTerminals(excludeHandles: string[] = []): string[] {
    const rows = this.db
      .prepare(
        `WITH handles(handle) AS (
           SELECT to_handle FROM messages
           UNION
           SELECT from_handle FROM messages
         )
         SELECT handle FROM handles
         WHERE length(CAST(handle AS BLOB)) <= ${ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES}
           AND NOT EXISTS (
             SELECT 1 FROM dispatch_contexts
             WHERE dispatch_contexts.assignee_handle = handles.handle
               AND dispatch_contexts.status IN ('pending', 'dispatched')
           )
         ORDER BY handle`
      )
      .iterate() as Iterable<{ handle: string }>
    const filtered = (function* (): Iterable<{ handle: string }> {
      for (const row of rows) {
        if (!excludeHandles.includes(row.handle)) {
          yield row
        }
      }
    })()
    return retainOrchestrationQueryRows(filtered).map((row) => row.handle)
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
