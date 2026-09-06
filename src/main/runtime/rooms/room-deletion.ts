import type { RoomDeletionManifest, RoomDatabase } from './database'
import type { RoomArchiveTransferStore } from './archive-transfers'
import type { RoomAttachmentTransferStore } from './attachment-transfers'
import type { RoomDeliveryWorker } from './delivery-worker'
import type { RoomEventBus } from './event-bus'
import type { RoomParticipantController } from './participant-controller'

export class RoomDeletionCoordinator {
  private readonly deletions = new Map<string, Promise<void>>()
  private readonly operations = new Map<string, Set<Promise<unknown>>>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly db: RoomDatabase,
    private readonly deliveries: RoomDeliveryWorker,
    private readonly participants: RoomParticipantController,
    private readonly archives: RoomArchiveTransferStore,
    private readonly attachments: RoomAttachmentTransferStore,
    private readonly events: RoomEventBus,
    private readonly cleanupExternal: (manifest: RoomDeletionManifest) => Promise<void>
  ) {}

  start(): void {
    void this.retryCleanup()
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  assertAvailable(roomId: string): void {
    if (this.deletions.has(roomId)) {
      throw new Error('room_deleting')
    }
    this.db.core.get(roomId)
  }

  run<T>(roomId: string, action: () => Promise<T>): Promise<T> {
    this.assertAvailable(roomId)
    const operation = action()
    const operations = this.operations.get(roomId) ?? new Set<Promise<unknown>>()
    operations.add(operation)
    this.operations.set(roomId, operations)
    const release = (): void => {
      operations.delete(operation)
      if (operations.size === 0) {
        this.operations.delete(roomId)
      }
    }
    void operation.then(release, release)
    return operation
  }

  delete(roomId: string): Promise<void> {
    const active = this.deletions.get(roomId)
    if (active) {
      return active
    }
    this.db.core.get(roomId)
    const deletion = this.deleteNow(roomId).finally(() => this.deletions.delete(roomId))
    this.deletions.set(roomId, deletion)
    return deletion
  }

  private async deleteNow(roomId: string): Promise<void> {
    let fence: ReturnType<RoomDeliveryWorker['requestRoomFence']> | null = null
    try {
      const operations = this.operations.get(roomId)
      if (operations) {
        await Promise.allSettled(operations)
      }
      fence = this.deliveries.requestRoomFence(roomId, { discardConfirmations: true })
      await fence.ready
      const forgetParticipants = await this.participants.blockRoom(roomId)
      this.archives.cancelRoom(roomId)
      const pendingUploadIds = await this.attachments.cancelRoom(roomId)
      const manifest: RoomDeletionManifest = {
        roomId,
        attachmentPaths: this.db.messages
          .listAttachments(roomId)
          .map((attachment) => attachment.localPath),
        pendingUploadIds,
        drops: this.db.listAttachmentDrops(roomId)
      }
      this.db.deleteRoom(manifest)
      this.archives.forgetRoom(roomId)
      this.attachments.forgetRoom(roomId)
      forgetParticipants()
      this.events.endRoom(roomId)
      await this.cleanup(manifest)
    } finally {
      fence?.release()
      this.participants.unblockRoom(roomId)
    }
  }

  private async cleanup(manifest: RoomDeletionManifest): Promise<void> {
    try {
      await Promise.all([
        this.attachments.removeRoomFiles(
          manifest.roomId,
          manifest.pendingUploadIds,
          manifest.attachmentPaths
        ),
        this.cleanupExternal(manifest)
      ])
      this.db.finishRoomDeletionCleanup(manifest.roomId)
    } catch {
      this.scheduleRetry()
    }
  }

  private async retryCleanup(): Promise<void> {
    for (const manifest of this.db.listRoomDeletionCleanup()) {
      await this.cleanup(manifest)
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) {
      return
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.retryCleanup()
    }, 30_000)
    this.retryTimer.unref?.()
  }
}
