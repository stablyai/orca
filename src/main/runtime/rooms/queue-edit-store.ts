import { randomUUID } from 'node:crypto'
import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomAttachment } from '../../../shared/rooms'
import { assertRoomMessageDeliveryMutable } from './delivery-mutability'
import type { RoomRow } from './rows'

export class RoomQueueEditStore {
  constructor(private readonly db: SyncDatabase.Database) {}

  assertMutable(messageId: string, editToken: string): void {
    assertRoomMessageDeliveryMutable(this.db, messageId, editToken)
  }

  begin(messageId: string): string {
    assertRoomMessageDeliveryMutable(this.db, messageId)
    const token = randomUUID()
    const changed = this.db
      .prepare(
        `UPDATE room_messages SET queue_edit_token = ?
         WHERE id = ? AND deleted_at IS NULL AND queue_edit_token IS NULL`
      )
      .run(token, messageId).changes
    if (changed !== 1) {
      throw new Error('room_delivery_queue_stale')
    }
    return token
  }

  finish(input: {
    messageId: string
    editToken: string
    body: string
    mentions: readonly string[]
    retainedAttachmentIds: readonly string[]
    attachments: readonly RoomAttachment[]
  }): string[] {
    assertRoomMessageDeliveryMutable(this.db, input.messageId, input.editToken)
    const current = this.db
      .prepare('SELECT id, local_path FROM room_attachments WHERE message_id = ?')
      .all(input.messageId) as RoomRow[]
    const retained = new Set(input.retainedAttachmentIds)
    if (
      retained.size !== input.retainedAttachmentIds.length ||
      [...retained].some((id) => !current.some((row) => String(row.id) === id)) ||
      retained.size + input.attachments.length > 10
    ) {
      throw new Error('room_attachment_count_exceeded')
    }
    if (!input.body.trim() && retained.size + input.attachments.length === 0) {
      throw new Error('room_message_empty')
    }
    const changed = this.db
      .prepare(
        `UPDATE room_messages SET body = ?, queue_edit_token = NULL
         WHERE id = ? AND queue_edit_token = ?`
      )
      .run(input.body.trim(), input.messageId, input.editToken).changes
    if (changed !== 1) {
      throw new Error('room_delivery_queue_stale')
    }
    this.replaceMentions(input.messageId, input.mentions)
    const removed = current.filter((row) => !retained.has(String(row.id)))
    for (const row of removed) {
      this.db
        .prepare('DELETE FROM room_attachments WHERE id = ? AND message_id = ?')
        .run(String(row.id), input.messageId)
    }
    const insert = this.db.prepare(
      `INSERT INTO room_attachments
       (id, message_id, file_name, mime_type, byte_size, local_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const attachment of input.attachments) {
      insert.run(
        attachment.id,
        input.messageId,
        attachment.fileName,
        attachment.mimeType,
        attachment.byteSize,
        attachment.localPath,
        attachment.createdAt
      )
    }
    return removed.map((row) => String(row.local_path))
  }

  cancel(messageId: string, editToken: string): void {
    const changed = this.db
      .prepare(
        'UPDATE room_messages SET queue_edit_token = NULL WHERE id = ? AND queue_edit_token = ?'
      )
      .run(messageId, editToken).changes
    if (changed !== 1) {
      throw new Error('room_delivery_queue_stale')
    }
  }

  private replaceMentions(messageId: string, mentions: readonly string[]): void {
    this.db.prepare('DELETE FROM room_message_mentions WHERE message_id = ?').run(messageId)
    const insert = this.db.prepare(
      `INSERT INTO room_message_mentions(message_id, identity, position) VALUES (?, ?, ?)`
    )
    mentions.forEach((identity, position) => insert.run(messageId, identity, position))
  }
}
