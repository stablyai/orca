import type { RoomDatabase } from './database'
import {
  archiveMessageKind,
  archiveMetadata,
  archiveNumber,
  archiveString,
  archiveTimestamp,
  archiveUid,
  extractArchiveZip,
  nullableArchiveTimestamp,
  parseArchiveJsonLines,
  parseArchiveObject,
  ROOM_ARCHIVE_FORMAT_VERSION,
  stableArchiveId
} from './archive-codec'

type ImportCounts = { created: number; duplicates: number; skipped: number }

export type RoomArchiveImportReport = {
  messages: ImportCounts
}

export class RoomArchiveImporter {
  constructor(private readonly db: RoomDatabase) {}

  async import(roomId: string, bytes: Uint8Array): Promise<RoomArchiveImportReport> {
    const files = await extractArchiveZip(bytes)
    const manifest = parseArchiveObject(files['manifest.json'], 'room_archive_manifest_invalid')
    const version = archiveNumber(manifest.schema_version, 0)
    if (version < 1 || version > ROOM_ARCHIVE_FORMAT_VERSION) {
      throw new Error('room_archive_version_unsupported')
    }
    const report = emptyReport()
    this.db.transaction(() => this.importFiles(roomId, files, report))
    return report
  }

  private importFiles(
    roomId: string,
    files: Record<string, Uint8Array>,
    report: RoomArchiveImportReport
  ): void {
    const participants = this.db.participants.list(roomId)
    const pendingReplies: [string, string][] = []
    const records = parseArchiveJsonLines(files['messages.jsonl'])
    for (const record of records.sort((a, b) => archiveTimestamp(a) - archiveTimestamp(b))) {
      const sourceId = archiveUid(record)
      const id = stableArchiveId(roomId, 'message', sourceId)
      if (this.db.messages.has(sourceId, roomId) || this.db.messages.has(id, roomId)) {
        report.messages.duplicates += 1
        continue
      }
      const body = archiveString(record.text ?? record.body, 262_144)
      if (!body && !record.deleted_at_ms) {
        report.messages.skipped += 1
        continue
      }
      const senderName = archiveString(record.sender ?? record.sender_identity, 80) || 'import'
      const sender = participants.find(
        (item) =>
          item.identity.toLowerCase() === senderName.toLowerCase() ||
          (item.actorKind === 'user' && senderName.toLowerCase() === 'you')
      )
      const message = this.db.messages.create({
        id,
        roomId,
        senderId: sender?.id ?? null,
        senderIdentity: sender?.identity ?? senderName,
        actorKind: sender?.actorKind ?? 'system',
        kind: archiveMessageKind(record.type),
        body,
        metadata: archiveMetadata(record.metadata, sourceId),
        mentions: [],
        createdAt: archiveTimestamp(record),
        editedAt: nullableArchiveTimestamp(record.edited_at_ms),
        deletedAt: nullableArchiveTimestamp(record.deleted_at_ms),
        enqueueDeliveries: false
      }).message
      const parentUid = archiveString(record.reply_to_uid, 256)
      if (parentUid) {
        pendingReplies.push([message.id, this.messageId(roomId, parentUid)])
      }
      report.messages.created += 1
    }
    for (const [messageId, parentId] of pendingReplies) {
      if (this.db.messages.has(parentId, roomId)) {
        this.db.messages.linkReply(messageId, parentId)
      }
    }
  }

  private messageId(roomId: string, sourceId: string): string {
    return this.db.messages.has(sourceId, roomId)
      ? sourceId
      : stableArchiveId(roomId, 'message', sourceId)
  }
}

function emptyReport(): RoomArchiveImportReport {
  const counts = (): ImportCounts => ({ created: 0, duplicates: 0, skipped: 0 })
  return {
    messages: counts()
  }
}
