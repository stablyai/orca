import {
  BotGroupLatestSchema,
  BotGroupSchema,
  BotGroupMessageSchema,
  LegacyBotGroupSchema,
  type LegacyBotGroup
} from '../../shared/bots/bot-group-schema'
import type Database from '../sqlite/sync-database'
import * as extras from './bot-group-store-extras'
import { botGroupRoom } from '../../shared/bots/bot-group'
import type {
  BotGroup,
  BotGroupLatest,
  BotGroupMember,
  BotGroupMessage,
  BotGroupTurn
} from '../../shared/bots/bot-group'

// The row's sequence is the message order; the record keeps everything else.
const MessageRecordSchema = BotGroupMessageSchema.omit({ sequence: true })

export type PendingGroupTurn = { message: BotGroupMessage; turn: BotGroupTurn }

export class BotGroupStore {
  private readonly writes: extras.BotGroupRecordWrites

  constructor(private readonly db: Database) {
    this.writes = new extras.BotGroupRecordWrites(db)
    db.exec(`CREATE TABLE IF NOT EXISTS bot_groups (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_group_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        group_id TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_group_operations (operation_id TEXT PRIMARY KEY, message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_group_pending (operation_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_group_worker_operations (dispatch_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS bot_group_worker_operation ON bot_group_worker_operations(operation_id);
      CREATE INDEX IF NOT EXISTS bot_group_messages_room ON bot_group_messages(group_id, sequence);
      -- Same expression as roomMessages, so a room page reads only its own thread's rows; any build's writes keep it current.
      CREATE INDEX IF NOT EXISTS bot_group_messages_thread
        ON bot_group_messages(group_id, coalesce(json_extract(record, '$.threadId'), ''), sequence);
      CREATE TABLE IF NOT EXISTS bot_group_sidebar (group_id TEXT PRIMARY KEY, sidebar_order INTEGER, latest TEXT);
      ${extras.BOT_GROUP_EXTRAS_TABLES}`)
  }

  /** Groups saved with a home; one still to migrate is listed once it has one. */
  list(): BotGroup[] {
    return this.records().flatMap((record) => BotGroupSchema.safeParse(record).data ?? [])
  }

  /** The groups as the sidebar lists them: each with its saved place and newest post. */
  listing(): BotGroup[] {
    const rows = new Map(
      this.db
        .prepare('SELECT group_id, sidebar_order, latest FROM bot_group_sidebar')
        .all()
        .map((row) => [String(row.group_id), row])
    )
    return this.list().map((group) => {
      const row = rows.get(group.id)
      const latest = row?.latest
        ? BotGroupLatestSchema.safeParse(JSON.parse(String(row.latest)))
        : null
      return {
        ...group,
        ...(typeof row?.sidebar_order === 'number' ? { sidebarOrder: row.sidebar_order } : {}),
        ...(latest?.success ? { latest: latest.data } : {})
      }
    })
  }

  // Kept beside the record, so a membership edit that writes the record back keeps them.
  setSidebarOrder(groupId: string, sidebarOrder: number): void {
    this.db
      .prepare(
        'INSERT INTO bot_group_sidebar(group_id, sidebar_order) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET sidebar_order = excluded.sidebar_order'
      )
      .run(groupId, sidebarOrder)
  }

  /** A reply's place among replies, taken when its turn ends: strictly increasing, and at least
   *  the clock, so it also stays ahead of places saved before a restart. */
  reserveReplyOrder(): number {
    this.lastReplyOrder = Math.max(Date.now(), this.lastReplyOrder + 1)
    return this.lastReplyOrder
  }

  private lastReplyOrder = 0

  /**
   * Keeps the newer of this and the saved post; true when it was kept. Order is the room's
   * message sequence: a post is at its own, a reply just after the newest post stored when it
   * ended; replies after the same post go by the order reserved when each ended, never a clock
   * that can tie. Its text is one short line: the row shows only the start.
   */
  setLatest(groupId: string, latest: BotGroupLatest, order: BotGroupLatestOrder): boolean {
    const text = latest.text.replace(/\s+/g, ' ').trim().slice(0, 500)
    // The order rides in the stored JSON; the listing's schema parse drops it.
    const sequence = 'post' in order ? order.post : order.after
    const tie = 'post' in order ? -1 : order.reply
    const result = this.db
      .prepare(
        `INSERT INTO bot_group_sidebar(group_id, latest) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET latest = excluded.latest
         WHERE latest IS NULL
           OR coalesce(json_extract(latest, '$.sequence'), -1) < json_extract(excluded.latest, '$.sequence')
           OR (coalesce(json_extract(latest, '$.sequence'), -1) = json_extract(excluded.latest, '$.sequence')
               AND coalesce(json_extract(latest, '$.tie'), -1) < json_extract(excluded.latest, '$.tie'))`
      )
      .run(groupId, JSON.stringify({ ...latest, text, sequence, tie }))
    return Number(result.changes) > 0
  }

  /** Groups saved before groups had homes, which startup migrates. */
  legacy(): LegacyBotGroup[] {
    return this.records().flatMap((record) =>
      BotGroupSchema.safeParse(record).success
        ? []
        : (LegacyBotGroupSchema.safeParse(record).data ?? [])
    )
  }

  private records(): unknown[] {
    return this.db
      .prepare(`SELECT record, ${extras.GROUP_EXTRAS} FROM bot_groups ORDER BY rowid`)
      .all()
      .map(extras.rowRecord)
  }

  get(id: string): BotGroup {
    const row = this.db
      .prepare(`SELECT record, ${extras.GROUP_EXTRAS} FROM bot_groups WHERE id = ?`)
      .get(id)
    if (!row) {
      throw new Error('Group not found.')
    }
    return BotGroupSchema.parse(extras.rowRecord(row))
  }

  /** The group room whose current member owns this native session, as `botGroupRoom` sees it. */
  memberOf(
    sessionId: string
  ): { group: BotGroup; member: BotGroupMember; threadId: string | undefined } | null {
    for (const group of this.list()) {
      for (const threadId of [undefined, ...(group.threads ?? []).map((thread) => thread.id)]) {
        const room = botGroupRoom(group, threadId)
        const member = room.members.find((member) => member.sessionId === sessionId)
        if (member) {
          return { group: room, member, threadId }
        }
      }
    }
    return null
  }

  room(groupId: string, threadId: string | undefined): BotGroup {
    return botGroupRoom(this.get(groupId), threadId)
  }

  put(group: BotGroup): void {
    this.transaction(() => this.writes.putGroup(group))
  }

  /** The group and everything kept for it: messages, pending sends, operation and worker links. */
  deleteGroup(groupId: string): void {
    const ofGroup = 'SELECT id FROM bot_group_messages WHERE group_id = ?'
    const operations = `SELECT operation_id FROM bot_group_operations WHERE message_id IN (${ofGroup})`
    this.transaction(() => {
      for (const statement of [
        `DELETE FROM bot_group_worker_operations WHERE operation_id IN (${operations})`,
        `DELETE FROM bot_group_operations WHERE message_id IN (${ofGroup})`,
        `DELETE FROM bot_group_message_extras WHERE message_id IN (${ofGroup})`,
        'DELETE FROM bot_group_extras WHERE group_id = ?',
        'DELETE FROM bot_group_pending WHERE group_id = ?',
        'DELETE FROM bot_group_messages WHERE group_id = ?',
        'DELETE FROM bot_group_sidebar WHERE group_id = ?',
        'DELETE FROM bot_groups WHERE id = ?'
      ]) {
        this.db.prepare(statement).run(groupId)
      }
    })
  }

  messages(
    groupId: string,
    limit = 40,
    beforeSequence = Number.MAX_SAFE_INTEGER
  ): BotGroupMessage[] {
    return this.db
      .prepare(
        `SELECT sequence, record, ${extras.MESSAGE_EXTRAS} FROM bot_group_messages WHERE group_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`
      )
      .all(groupId, beforeSequence, limit)
      .toReversed()
      .map((row) => this.messageRow(row))
  }

  /** One room's messages: a thread's, or the original room's when `threadId` is absent. */
  roomMessages(
    groupId: string,
    threadId: string | undefined,
    limit = 40,
    beforeSequence = Number.MAX_SAFE_INTEGER
  ): BotGroupMessage[] {
    return this.db
      .prepare(
        `SELECT sequence, record, ${extras.MESSAGE_EXTRAS} FROM bot_group_messages WHERE group_id = ? AND sequence < ?
           AND coalesce(json_extract(record, '$.threadId'), '') = ? ORDER BY sequence DESC LIMIT ?`
      )
      .all(groupId, beforeSequence, threadId ?? '', limit)
      .toReversed()
      .map((row) => this.messageRow(row))
  }

  message(id: string): BotGroupMessage | null {
    const row = this.db
      .prepare(
        `SELECT sequence, record, ${extras.MESSAGE_EXTRAS} FROM bot_group_messages WHERE id = ?`
      )
      .get(id)
    return row ? this.messageRow(row) : null
  }

  operationMessage(operationId: string): BotGroupMessage | null {
    const row = this.db
      .prepare('SELECT message_id FROM bot_group_operations WHERE operation_id = ?')
      .get(operationId)
    return row ? this.message(String(row.message_id)) : null
  }

  /** Stores a post with each turn's pending context, owed until native admission. */
  append(message: Omit<BotGroupMessage, 'sequence'>, contexts = new Map<string, string>()) {
    this.transaction(() => {
      this.writes.insertMessage(message)
      for (const { operationId } of message.turns) {
        this.link(operationId, message.id)
        const context = contexts.get(operationId)
        if (context !== undefined) {
          this.db
            .prepare(
              'INSERT INTO bot_group_pending(operation_id, group_id, context) VALUES (?, ?, ?)'
            )
            .run(operationId, message.groupId, context)
        }
      }
    })
    const stored = this.message(message.id)
    if (!stored) {
      throw new Error('The group message was not stored.')
    }
    return stored
  }

  /** A mail line's next attempt: its one turn moves to the new id, linked to the line, and an
   *  error the dead attempt settled to is dropped. */
  retarget(messageId: string, operationId: string): void {
    const message = this.message(messageId)
    if (!message?.turns[0]) {
      return
    }
    // The dead id keeps its link: it names no turn of the line, so nothing resolves through it.
    this.transaction(() => {
      const { error: _error, ...turn } = message.turns[0]
      this.update({ ...message, turns: [{ ...turn, operationId }] })
      this.link(operationId, messageId)
    })
  }

  private link(operationId: string, messageId: string): void {
    this.db
      .prepare('INSERT INTO bot_group_operations(operation_id, message_id) VALUES (?, ?)')
      .run(operationId, messageId)
  }

  bindWorker(dispatchId: string, operationId: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO bot_group_worker_operations(dispatch_id, operation_id) VALUES (?, ?)'
      )
      .run(dispatchId, operationId)
  }

  /** The group operation that started this worker. */
  workerOperation(dispatchId: string): string | null {
    const row = this.db
      .prepare('SELECT operation_id FROM bot_group_worker_operations WHERE dispatch_id = ?')
      .get(dispatchId)
    return row ? String(row.operation_id) : null
  }

  /** Every turn, in any group, whose native admission is still owed. */
  pending(): PendingGroupTurn[] {
    return this.db
      .prepare('SELECT operation_id FROM bot_group_pending')
      .all()
      .flatMap((row) => {
        const message = this.operationMessage(String(row.operation_id))
        const turn = message?.turns.find((turn) => turn.operationId === row.operation_id)
        return message && turn ? [{ message, turn }] : []
      })
  }

  pendingContext(operationId: string): string | null {
    const row = this.db
      .prepare('SELECT context FROM bot_group_pending WHERE operation_id = ?')
      .get(operationId)
    return row ? String(row.context) : null
  }

  delivered(operationIds: readonly string[]): void {
    const remove = this.db.prepare('DELETE FROM bot_group_pending WHERE operation_id = ?')
    for (const operationId of operationIds) {
      remove.run(operationId)
    }
  }

  transaction(work: () => void): void {
    this.db.exec('SAVEPOINT bot_group_write')
    try {
      work()
      this.db.exec('RELEASE bot_group_write')
    } catch (error) {
      this.db.exec('ROLLBACK TO bot_group_write')
      this.db.exec('RELEASE bot_group_write')
      throw error
    }
  }

  update({ sequence: _sequence, ...message }: BotGroupMessage): void {
    const turns = message.turns.map(({ workerDispatchIds: _workers, ...turn }) => turn)
    this.transaction(() => this.writes.updateMessage({ ...message, turns }))
  }

  private messageRow(row: Record<string, unknown>): BotGroupMessage {
    const message = MessageRecordSchema.parse(extras.rowRecord(row))
    const workers = this.db.prepare(
      'SELECT dispatch_id FROM bot_group_worker_operations WHERE operation_id = ? ORDER BY rowid'
    )
    return {
      ...message,
      sequence: Number(row.sequence),
      turns: message.turns.map(({ workerDispatchIds: _stored, ...turn }) => {
        const dispatchIds = workers
          .all(turn.operationId)
          .map((worker) => String(worker.dispatch_id))
        return dispatchIds.length > 0 ? { ...turn, workerDispatchIds: dispatchIds } : turn
      })
    }
  }
}

/** Where a latest post sits in the room: a post's own sequence, or a reply's place after one. */
export type BotGroupLatestOrder = { post: number } | { after: number; reply: number }
