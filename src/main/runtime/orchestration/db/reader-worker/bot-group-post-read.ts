import { BoundedMap } from '../../../../../shared/collections/bounded-map'
import {
  BotGroupMessageSchema,
  type BotGroupMessage
} from '../../../../../shared/bots/bot-group-schema'
import type Database from '../../../../sqlite/sync-database'
import { projectBotGroupRoomPost } from '../../../../bots/bot-group-page-replies'
import type { BotGroupPostReadInput, BotGroupPostReadResult } from './orchestration-reader-protocol'

const MessageRecordSchema = BotGroupMessageSchema.omit({ sequence: true })

/** The reader's page cache is bounded to its connection and is invalidated by each worker restart. */
const roomPosts = new WeakMap<
  Database,
  BoundedMap<string, { post: BotGroupMessage; bytes: number }>
>()

function cacheFor(db: Database): BoundedMap<string, { post: BotGroupMessage; bytes: number }> {
  let cache = roomPosts.get(db)
  if (!cache) {
    cache = new BoundedMap({
      maxEntries: 160,
      maxBytes: 32 * 1024 * 1024,
      sizeOf: (entry) => entry.bytes
    })
    roomPosts.set(db, cache)
  }
  return cache
}

function messageRow(db: Database, row: Record<string, unknown>): BotGroupMessage {
  const message = MessageRecordSchema.parse(JSON.parse(String(row.record)))
  if (message.turns.length === 0) {
    return { ...message, sequence: Number(row.sequence) }
  }
  const workers = db.prepare(
    'SELECT dispatch_id FROM bot_group_worker_operations WHERE operation_id = ? ORDER BY rowid'
  )
  return {
    ...message,
    sequence: Number(row.sequence),
    turns: message.turns.map(({ workerDispatchIds: _stored, ...turn }) => {
      const dispatchIds = workers.all(turn.operationId).map((worker) => String(worker.dispatch_id))
      return dispatchIds.length > 0 ? { ...turn, workerDispatchIds: dispatchIds } : turn
    })
  }
}

function projectPost(db: Database, id: string, row: Record<string, unknown>): BotGroupMessage {
  const cache = cacheFor(db)
  const cached = cache.get(id)
  if (cached) {
    return cached.post
  }
  const post = projectBotGroupRoomPost(messageRow(db, row))
  cache.set(id, { post, bytes: JSON.stringify(post).length * 2 })
  return post
}

export function readBotGroupPosts(
  db: Database,
  input: BotGroupPostReadInput
): BotGroupPostReadResult {
  if (input.kind === 'operation') {
    const operation = db
      .prepare('SELECT message_id FROM bot_group_operations WHERE operation_id=?')
      .get(input.operationId)
    if (!operation) {
      return { kind: 'post', message: null }
    }
    input = { kind: 'post', id: String(operation.message_id) }
  }
  if (input.kind === 'post') {
    const row = db
      .prepare('SELECT sequence, record FROM bot_group_messages WHERE id=?')
      .get(input.id)
    return { kind: 'post', message: row ? projectPost(db, input.id, row) : null }
  }
  const rows = db
    .prepare(`SELECT id, sequence, record FROM bot_group_messages
      WHERE group_id=? AND sequence<? AND coalesce(json_extract(record, '$.threadId'), '')=?
      ORDER BY sequence DESC LIMIT ?`)
    .all(
      input.groupId,
      input.beforeSequence ?? Number.MAX_SAFE_INTEGER,
      input.threadId ?? '',
      input.limit
    )
    .toReversed()
  return { kind: 'page', messages: rows.map((row) => projectPost(db, String(row.id), row)) }
}
