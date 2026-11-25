import { BoundedMap } from '../../shared/collections/bounded-map'
import { BotGroupMessageSchema, type BotGroupMessage } from '../../shared/bots/bot-group-schema'
import type Database from '../sqlite/sync-database'

// The row's sequence is the message order; the record keeps everything else.
const MessageRecordSchema = BotGroupMessageSchema.omit({ sequence: true })

export class BotGroupPostRead {
  private readonly roomPosts = new BoundedMap<string, { post: BotGroupMessage; bytes: number }>({
    maxEntries: 160,
    maxBytes: 32 * 1024 * 1024,
    sizeOf: (entry) => entry.bytes
  })

  constructor(private readonly db: Database) {}

  invalidate(id: string): void {
    this.roomPosts.delete(id)
  }

  clear(): void {
    this.roomPosts.clear()
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
    beforeSequence = Number.MAX_SAFE_INTEGER
  ): BotGroupMessage[] {
    const ids = this.db
      .prepare(
        `SELECT id FROM bot_group_messages WHERE group_id = ? AND sequence < ?
           AND coalesce(json_extract(record, '$.threadId'), '') = ? ORDER BY sequence DESC LIMIT ?`
      )
      .all(groupId, beforeSequence, threadId ?? '', limit)
    return ids.toReversed().flatMap(({ id }) => this.roomPost(String(id)) ?? [])
  }

  message(id: string): BotGroupMessage | null {
    const row = this.messageRecord(id)
    return row ? this.messageRow(row) : null
  }

  private messageRecord(id: string) {
    return this.db.prepare('SELECT sequence, record FROM bot_group_messages WHERE id = ?').get(id)
  }

  private roomPost(id: string): BotGroupMessage | null {
    const cached = this.roomPosts.get(id)
    if (cached) {
      return cached.post
    }
    const row = this.messageRecord(id)
    if (!row) {
      return null
    }
    const post = this.messageRow(row)
    this.roomPosts.set(id, { post, bytes: String(row.record).length * 2 })
    return post
  }

  private messageRow(row: Record<string, unknown>): BotGroupMessage {
    const message = MessageRecordSchema.parse(JSON.parse(String(row.record)))
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
