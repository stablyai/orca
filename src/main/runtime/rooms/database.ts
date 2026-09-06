import SyncDatabase from '../../sqlite/sync-database'
import type { RoomSnapshot } from '../../../shared/rooms'
import { initializeRoomSchema } from './schema'
import { RoomCoreStore } from './core-store'
import { RoomMessageStore } from './messages'
import { RoomPinStore } from './pins'
import { RoomParticipantStore } from './participants'
import { RoomProviderMessageStore } from './provider-messages'
import { RoomActivityStore } from './activities'
import { RoomDeliveryConfigurationStore } from './delivery-configuration'
import { RoomNotificationReplayStore } from './notification-replay'
import { RoomQueueEditStore } from './queue-edit-store'

export type RoomDeletionManifest = {
  roomId: string
  attachmentPaths: string[]
  pendingUploadIds: string[]
  drops: { connectionId: string; remotePath: string }[]
}

export class RoomDatabase {
  private readonly db: SyncDatabase.Database
  readonly core: RoomCoreStore
  readonly participants: RoomParticipantStore
  readonly messages: RoomMessageStore
  readonly pins: RoomPinStore
  readonly providerMessages: RoomProviderMessageStore
  readonly activities: RoomActivityStore
  readonly deliveryConfiguration: RoomDeliveryConfigurationStore
  readonly notificationReplay: RoomNotificationReplayStore
  readonly queueEdits: RoomQueueEditStore

  constructor(
    path: string,
    readSessionOptions?: ConstructorParameters<typeof RoomParticipantStore>[1]
  ) {
    this.db = new SyncDatabase(path)
    initializeRoomSchema(this.db)
    this.core = new RoomCoreStore(this.db)
    this.participants = new RoomParticipantStore(this.db, readSessionOptions)
    this.messages = new RoomMessageStore(this.db)
    this.pins = new RoomPinStore(this.db)
    this.providerMessages = new RoomProviderMessageStore(this.db, this.messages)
    this.activities = new RoomActivityStore(this.db)
    this.deliveryConfiguration = new RoomDeliveryConfigurationStore(this.db)
    this.notificationReplay = new RoomNotificationReplayStore(this.db)
    this.queueEdits = new RoomQueueEditStore(this.db)
  }

  close(): void {
    this.db.close()
  }

  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  createRoom(input: Parameters<RoomCoreStore['create']>[0]): RoomSnapshot {
    const room = this.core.create(input)
    return this.snapshot(room.id, input.userIdentity?.trim() || 'user')
  }

  snapshot(roomId: string, readerKey = 'user'): RoomSnapshot {
    return {
      room: this.core.get(roomId),
      participants: this.participants.list(roomId),
      activities: this.activities.list(roomId),
      roles: this.core.listRoles(roomId),
      pins: this.pins.list(roomId),
      unread: this.messages.getUnread(roomId, readerKey),
      workState: this.messages.deliveries.workState(roomId),
      deliveryQueueVersion: 1,
      deliveryQueueMutationVersion: 1,
      broadcastQueuePlacementVersion: 1,
      queueComposerEditVersion: 1
    }
  }

  recordAttachmentDrop(attachmentId: string, connectionId: string, remotePath: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO room_attachment_drops
         (room_id, attachment_id, connection_id, remote_path)
         SELECT m.room_id, a.id, ?, ? FROM room_attachments a
         JOIN room_messages m ON m.id = a.message_id WHERE a.id = ?`
      )
      .run(connectionId, remotePath, attachmentId)
  }

  listAttachmentDrops(roomId: string): RoomDeletionManifest['drops'] {
    return (
      this.db
        .prepare('SELECT connection_id, remote_path FROM room_attachment_drops WHERE room_id = ?')
        .all(roomId) as Record<string, unknown>[]
    ).map((row) => ({
      connectionId: String(row.connection_id),
      remotePath: String(row.remote_path)
    }))
  }

  deleteRoom(manifest: RoomDeletionManifest): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO room_deletion_cleanup (room_id, manifest_json, created_at)
           VALUES (?, ?, ?)`
        )
        .run(manifest.roomId, JSON.stringify(manifest), Date.now())
      this.core.delete(manifest.roomId)
    })
  }

  listRoomDeletionCleanup(): RoomDeletionManifest[] {
    return (
      this.db.prepare('SELECT manifest_json FROM room_deletion_cleanup').all() as {
        manifest_json: string
      }[]
    ).map((row) => JSON.parse(row.manifest_json) as RoomDeletionManifest)
  }

  finishRoomDeletionCleanup(roomId: string): void {
    this.db.prepare('DELETE FROM room_deletion_cleanup WHERE room_id = ?').run(roomId)
  }
}
