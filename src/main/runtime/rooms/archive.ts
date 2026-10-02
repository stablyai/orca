import { randomUUID } from 'node:crypto'
import { strToU8, type AsyncZippable } from 'fflate'
import type { RoomMessage } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import {
  createArchiveZip,
  MAX_ROOM_ARCHIVE_BYTES,
  ROOM_ARCHIVE_FORMAT_VERSION
} from './archive-codec'
import { RoomArchiveImporter, type RoomArchiveImportReport } from './archive-importer'

export type { RoomArchiveImportReport } from './archive-importer'

export class RoomArchive {
  private readonly importer: RoomArchiveImporter

  constructor(private readonly db: RoomDatabase) {
    this.importer = new RoomArchiveImporter(db)
  }

  async export(roomId: string): Promise<Buffer> {
    const snapshot = this.db.snapshot(roomId)
    const messages = this.allMessages(roomId)
    const messageRecords = messages.map((message) => ({
      uid: message.id,
      sender: message.senderIdentity,
      actor_kind: message.actorKind,
      text: message.body,
      type: message.kind,
      metadata: message.metadata,
      mentions: message.mentions,
      created_at_ms: message.createdAt,
      edited_at_ms: message.editedAt,
      deleted_at_ms: message.deletedAt,
      reply_to_uid: message.replyToId
    }))
    const files: AsyncZippable = {
      'manifest.json': strToU8(
        JSON.stringify({
          schema_version: ROOM_ARCHIVE_FORMAT_VERSION,
          archive_id: randomUUID(),
          product: 'orca',
          room_id: snapshot.room.id,
          room_name: snapshot.room.name,
          created_at: new Date().toISOString(),
          attachments_included: false
        })
      ),
      'messages.jsonl': strToU8(messageRecords.map((record) => JSON.stringify(record)).join('\n'))
    }
    return Buffer.from(await createArchiveZip(files))
  }

  import(roomId: string, bytes: Uint8Array): Promise<RoomArchiveImportReport> {
    this.db.core.get(roomId)
    if (bytes.byteLength > MAX_ROOM_ARCHIVE_BYTES) {
      return Promise.reject(new Error('room_archive_too_large'))
    }
    return this.importer.import(roomId, bytes)
  }

  private allMessages(roomId: string): RoomMessage[] {
    const result: RoomMessage[] = []
    let before: number | null = null
    do {
      const page = this.db.messages.list(roomId, before, 200)
      result.unshift(...page.messages)
      before = page.beforeSequence
      if (!page.hasMore) {
        break
      }
    } while (before !== null)
    return result
  }
}
