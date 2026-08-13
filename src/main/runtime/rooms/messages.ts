import { randomUUID } from 'node:crypto'
import type SyncDatabase from '../../sqlite/sync-database'
import type {
  RoomAttachment,
  RoomMessage,
  RoomMessagePage,
  RoomUnread
} from '../../../shared/rooms'
import { attachmentFromRow, type RoomRow } from './rows'
import { RoomDeliveryStore } from './deliveries'
import { getRoomUnread, hydrateRoomMessages } from './message-queries'
import type { CreateRoomMessage } from './message-input'

export class RoomMessageStore {
  readonly deliveries: RoomDeliveryStore

  constructor(private readonly db: SyncDatabase.Database) {
    this.deliveries = new RoomDeliveryStore(db)
  }

  create(input: CreateRoomMessage): {
    message: RoomMessage
    deliveries: ReturnType<RoomDeliveryStore['listForMessage']>
  } {
    const now = input.createdAt ?? Date.now()
    const id = input.id ?? randomUUID()
    const mentions = [
      ...new Set((input.mentions ?? []).map((value) => value.trim()).filter(Boolean))
    ]
    this.db.exec('SAVEPOINT room_message_create')
    try {
      const room = this.db
        .prepare('SELECT loop_limit FROM rooms WHERE id = ? AND archived_at IS NULL')
        .get(input.roomId) as RoomRow | undefined
      if (!room) {
        throw new Error('room_not_found')
      }
      if (input.senderId) {
        const sender = this.db
          .prepare(
            `SELECT id FROM room_participants
             WHERE id = ? AND room_id = ? AND actor_kind = ? AND identity = ? COLLATE NOCASE`
          )
          .get(input.senderId, input.roomId, input.actorKind, input.senderIdentity) as
          | RoomRow
          | undefined
        if (!sender) {
          throw new Error('room_message_sender_invalid')
        }
      } else if (input.actorKind !== 'system') {
        throw new Error('room_message_sender_required')
      }
      const parent = input.replyToId
        ? (this.db
            .prepare(
              `SELECT id, root_message_id, hop_count FROM room_messages
               WHERE id = ? AND room_id = ? AND deleted_at IS NULL`
            )
            .get(input.replyToId, input.roomId) as RoomRow | undefined)
        : undefined
      if (input.replyToId && !parent) {
        throw new Error('room_reply_not_found')
      }
      const rootMessageId = parent
        ? typeof parent.root_message_id === 'string'
          ? parent.root_message_id
          : String(parent.id)
        : input.actorKind === 'user'
          ? id
          : null
      const hopCount = input.actorKind === 'agent' && parent ? Number(parent.hop_count) + 1 : 0

      this.db
        .prepare(
          `INSERT INTO room_messages (
             id, room_id, sender_id, sender_identity, actor_kind, kind,
             body, reply_to_id, root_message_id, hop_count, metadata_json, created_at,
             edited_at, deleted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.roomId,
          input.senderId,
          input.senderIdentity,
          input.actorKind,
          input.kind ?? 'chat',
          input.body,
          input.replyToId ?? null,
          rootMessageId,
          hopCount,
          JSON.stringify(input.metadata ?? {}),
          now,
          input.editedAt ?? null,
          input.deletedAt ?? null
        )
      this.db.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').run(now, input.roomId)
      const mentionStatement = this.db.prepare(
        `INSERT OR IGNORE INTO room_message_mentions(message_id, identity, position)
         VALUES (?, ?, ?)`
      )
      for (const [position, identity] of mentions.entries()) {
        mentionStatement.run(id, identity, position)
      }
      const attachmentStatement = this.db.prepare(
        `INSERT INTO room_attachments
         (id, message_id, file_name, mime_type, byte_size, local_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      for (const attachment of input.attachments ?? []) {
        attachmentStatement.run(
          attachment.id,
          id,
          attachment.fileName,
          attachment.mimeType,
          attachment.byteSize,
          attachment.localPath,
          attachment.createdAt ?? now
        )
      }

      const deliveryStatement = this.db.prepare(
        `INSERT OR IGNORE INTO room_deliveries
         (id, message_id, participant_id, state, next_attempt_at) VALUES (?, ?, ?, ?, ?)`
      )
      const targets =
        input.enqueueDeliveries !== false
          ? (this.db
              .prepare(
                `SELECT id FROM room_participants
                 WHERE room_id = ? AND actor_kind = 'agent' AND participation = 'active'`
              )
              .all(input.roomId) as RoomRow[])
          : []
      const loopLimit = Number(room.loop_limit)
      const suppressed =
        input.actorKind === 'agent' && loopLimit > 0 && hopCount > 0 && hopCount % loopLimit === 0
      for (const target of targets) {
        if (target.id === input.senderId) {
          continue
        }
        deliveryStatement.run(
          randomUUID(),
          id,
          String(target.id),
          suppressed ? 'suppressed' : 'pending',
          now
        )
      }
      this.db.exec('RELEASE room_message_create')
    } catch (error) {
      this.db.exec('ROLLBACK TO room_message_create')
      this.db.exec('RELEASE room_message_create')
      throw error
    }
    return { message: this.get(id), deliveries: this.deliveries.listForMessage(id) }
  }

  get(id: string): RoomMessage {
    const row = this.db.prepare('SELECT * FROM room_messages WHERE id = ?').get(id) as
      | RoomRow
      | undefined
    if (!row) {
      throw new Error('room_message_not_found')
    }
    return hydrateRoomMessages(this.db, [row])[0]
  }

  has(id: string, roomId?: string): boolean {
    return Boolean(
      roomId
        ? this.db
            .prepare('SELECT 1 FROM room_messages WHERE id = ? AND room_id = ?')
            .get(id, roomId)
        : this.db.prepare('SELECT 1 FROM room_messages WHERE id = ?').get(id)
    )
  }

  getAttachment(id: string, roomId: string): RoomAttachment {
    const row = this.db
      .prepare(
        `SELECT a.* FROM room_attachments a
         JOIN room_messages m ON m.id = a.message_id
         WHERE a.id = ? AND m.room_id = ? AND m.deleted_at IS NULL`
      )
      .get(id, roomId) as RoomRow | undefined
    if (!row) {
      throw new Error('room_attachment_not_found')
    }
    return attachmentFromRow(row)
  }

  linkReply(id: string, replyToId: string): void {
    const message = this.get(id)
    const parent = this.get(replyToId)
    if (message.roomId !== parent.roomId || id === replyToId) {
      throw new Error('room_reply_not_found')
    }
    const cycle = this.db
      .prepare(
        `WITH RECURSIVE chain(id) AS (
           SELECT ? UNION ALL
           SELECT m.reply_to_id FROM room_messages m JOIN chain c ON m.id = c.id
           WHERE m.reply_to_id IS NOT NULL
         ) SELECT 1 FROM chain WHERE id = ? LIMIT 1`
      )
      .get(replyToId, id)
    if (cycle) {
      throw new Error('room_reply_cycle')
    }
    const rootMessageId = parent.rootMessageId ?? parent.id
    const hopCount = message.actorKind === 'agent' ? parent.hopCount + 1 : message.hopCount
    this.db
      .prepare(
        'UPDATE room_messages SET reply_to_id = ?, root_message_id = ?, hop_count = ? WHERE id = ?'
      )
      .run(replyToId, rootMessageId, hopCount, id)
  }

  list(roomId: string, beforeSequence: number | null, limit: number): RoomMessagePage {
    const boundedLimit = Math.min(Math.max(limit, 1), 200)
    const rows = this.db
      .prepare(
        `SELECT * FROM room_messages
         WHERE room_id = ? AND (? IS NULL OR sequence < ?)
         ORDER BY sequence DESC LIMIT ?`
      )
      .all(roomId, beforeSequence, beforeSequence, boundedLimit + 1) as RoomRow[]
    const hasMore = rows.length > boundedLimit
    const pageRows = rows.slice(0, boundedLimit).toReversed()
    const messages = hydrateRoomMessages(this.db, pageRows)
    return {
      messages,
      deliveries: this.deliveries.listForMessages(messages.map((message) => message.id)),
      hasMore,
      beforeSequence: hasMore && messages.length > 0 ? messages[0].sequence : null
    }
  }

  update(id: string, body: string, metadata?: Record<string, unknown>): RoomMessage {
    const current = this.get(id)
    const editedAt = Date.now()
    this.db
      .prepare('UPDATE room_messages SET body = ?, metadata_json = ?, edited_at = ? WHERE id = ?')
      .run(body, JSON.stringify(metadata ?? current.metadata), editedAt, id)
    return this.get(id)
  }

  delete(ids: string[]): string[] {
    if (ids.length === 0) {
      return []
    }
    const placeholders = ids.map(() => '?').join(', ')
    const paths = this.db
      .prepare(`SELECT local_path FROM room_attachments WHERE message_id IN (${placeholders})`)
      .all(...ids)
      .map((row) => String((row as RoomRow).local_path))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `UPDATE room_messages SET body = '', metadata_json = '{}', deleted_at = ?
           WHERE id IN (${placeholders}) AND deleted_at IS NULL`
        )
        .run(Date.now(), ...ids)
      this.db
        .prepare(`DELETE FROM room_attachments WHERE message_id IN (${placeholders})`)
        .run(...ids)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return paths
  }

  markRead(roomId: string, readerKey: string, sequence: number): RoomUnread {
    const now = Date.now()
    const row = this.db
      .prepare('SELECT max(sequence) AS sequence FROM room_messages WHERE room_id = ?')
      .get(roomId) as RoomRow | undefined
    const boundedSequence = Math.min(Math.max(0, sequence), Number(row?.sequence ?? 0))
    this.db
      .prepare(
        `INSERT INTO room_reads(room_id, reader_key, last_read_sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id, reader_key) DO UPDATE SET
           last_read_sequence = max(last_read_sequence, excluded.last_read_sequence),
           updated_at = excluded.updated_at`
      )
      .run(roomId, readerKey, boundedSequence, now)
    return this.getUnread(roomId, readerKey)
  }

  getUnread(roomId: string, readerKey: string): RoomUnread {
    return getRoomUnread(this.db, roomId, readerKey)
  }
}
