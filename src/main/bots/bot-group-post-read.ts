import { BoundedMap } from '../../shared/collections/bounded-map'
import { BotGroupMessageSchema, type BotGroupMessage } from '../../shared/bots/bot-group-schema'
import type Database from '../sqlite/sync-database'
import { projectBotGroupRoomPost } from './bot-group-page-replies'

// The row's sequence is the message order; the record keeps everything else.
const MessageRecordSchema = BotGroupMessageSchema.omit({ sequence: true })
let nextDetailVersion = 0

export class BotGroupPostRead {
  private readonly roomPosts = new BoundedMap<string, { post: BotGroupMessage; bytes: number }>({
    maxEntries: 160,
    maxBytes: 32 * 1024 * 1024,
    sizeOf: (entry) => entry.bytes
  })
  private readonly detailVersions = new BoundedMap<string, number>({ maxEntries: 160 })

  constructor(private readonly db: Database) {}

  invalidate(id: string): void {
    this.roomPosts.delete(id)
  }

  invalidateArchive(id: string): void {
    this.detailVersions.delete(id)
  }

  clear(): void {
    this.roomPosts.clear()
    this.detailVersions.clear()
  }

  detailVersion(id: string): number {
    let version = this.detailVersions.get(id)
    if (version === undefined) {
      version = ++nextDetailVersion
      this.detailVersions.set(id, version)
    }
    return version
  }

  operationMessageId(operationId: string): string | undefined {
    const row = this.db
      .prepare('SELECT message_id FROM bot_group_operations WHERE operation_id = ?')
      .get(operationId)
    return row ? String(row.message_id) : undefined
  }

  dropGroup(groupId: string): void {
    for (const [id, { post }] of this.roomPosts.entries()) {
      if (post.groupId === groupId) {
        this.roomPosts.delete(id)
      }
    }
  }

  messages(
    groupId: string,
    limit = 40,
    beforeSequence = Number.MAX_SAFE_INTEGER
  ): BotGroupMessage[] {
    return this.db
      .prepare(
        'SELECT sequence, record FROM bot_group_messages WHERE group_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?'
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
    beforeSequence = Number.MAX_SAFE_INTEGER,
    display = false
  ): BotGroupMessage[] {
    const rows = this.db
      .prepare(`SELECT ${display ? 'id' : 'sequence, record'} FROM bot_group_messages
        WHERE group_id=? AND sequence<? AND coalesce(json_extract(record, '$.threadId'), '')=?
        ORDER BY sequence DESC LIMIT ?`)
      .all(groupId, beforeSequence, threadId ?? '', limit)
    if (!display) {
      return rows.toReversed().map((row) => this.messageRow(row))
    }
    const ids = rows.toReversed().map(({ id }) => String(id))
    const found = new Map<string, BotGroupMessage>()
    const missing = ids.filter((id) => {
      const cached = this.roomPosts.get(id)
      if (cached) {
        found.set(id, cached.post)
      }
      return !cached
    })
    if (missing.length) {
      const unresolved = this.db
        .prepare(`SELECT id, sequence, record FROM bot_group_messages
        WHERE id IN (SELECT value FROM json_each(?)) ORDER BY sequence`)
        .all(JSON.stringify(missing))
      for (const row of unresolved) {
        found.set(String(row.id), this.rememberRoomPost(String(row.id), row))
      }
    }
    return ids.flatMap((id) => found.get(id) ?? [])
  }

  message(id: string): BotGroupMessage | null {
    const row = this.messageRecord(id)
    return row ? this.messageRow(row) : null
  }

  private messageRecord(id: string) {
    return this.db.prepare('SELECT sequence, record FROM bot_group_messages WHERE id = ?').get(id)
  }

  roomPost(id: string): BotGroupMessage | null {
    const cached = this.roomPosts.get(id)
    if (cached) {
      return cached.post
    }
    const row = this.messageRecord(id)
    if (!row) {
      return null
    }
    return this.rememberRoomPost(id, row)
  }

  private rememberRoomPost(id: string, row: Record<string, unknown>): BotGroupMessage {
    const post = projectBotGroupRoomPost(this.messageRow(row))
    this.roomPosts.set(id, { post, bytes: JSON.stringify(post).length * 2 })
    return post
  }

  private messageRow(row: Record<string, unknown>): BotGroupMessage {
    const message = MessageRecordSchema.parse(JSON.parse(String(row.record)))
    if (message.turns.length === 0) {
      return { ...message, sequence: Number(row.sequence) }
    }
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
