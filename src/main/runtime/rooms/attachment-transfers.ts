import { randomUUID } from 'node:crypto'
import type { RoomDatabase } from './database'
import type { RoomAttachmentManager } from './attachments'
import { ROOM_ATTACHMENT_CHUNK_BYTES } from './attachments'

const DOWNLOAD_TTL_MS = 5 * 60_000
const MAX_DOWNLOADS = 10

type Download = {
  roomId: string
  path: string
  fileName: string
  mimeType: string
  byteLength: number
  touchedAt: number
}

export class RoomAttachmentTransferStore {
  private readonly downloads = new Map<string, Download>()
  private readonly activeReads = new Map<string, Set<Promise<unknown>>>()
  private readonly roomGenerations = new Map<string, number>()

  constructor(
    private readonly db: RoomDatabase,
    private readonly manager: RoomAttachmentManager
  ) {}

  async startUpload(
    roomId: string,
    fileName: string,
    byteSize: number
  ): Promise<{
    uploadId: string
    chunkBytes: number
  }> {
    this.db.core.get(roomId)
    const generation = this.roomGenerations.get(roomId) ?? 0
    const uploadId = await this.manager.startUpload(roomId, fileName, byteSize)
    if ((this.roomGenerations.get(roomId) ?? 0) !== generation) {
      await this.manager.cancelUpload(uploadId)
      throw new Error('room_not_found')
    }
    return {
      uploadId,
      chunkBytes: ROOM_ATTACHMENT_CHUNK_BYTES
    }
  }

  appendUpload(
    uploadId: string,
    offset: number,
    contentBase64: string
  ): Promise<{
    nextOffset: number
  }> {
    return this.manager
      .appendUpload(uploadId, offset, contentBase64)
      .then((nextOffset) => ({ nextOffset }))
  }

  uploadRoomId(uploadId: string): string {
    return this.manager.uploadRoomId(uploadId)
  }

  finishUpload(uploadId: string): void {
    this.manager.finishUpload(uploadId)
  }

  cancelUpload(uploadId: string): Promise<void> {
    return this.manager.cancelUpload(uploadId)
  }

  async startDownload(
    roomId: string,
    attachmentId: string
  ): Promise<{
    transferId: string
    fileName: string
    mimeType: string
    byteLength: number
    chunkBytes: number
  }> {
    const generation = this.roomGenerations.get(roomId) ?? 0
    this.cleanup()
    if (this.downloads.size >= MAX_DOWNLOADS) {
      throw new Error('room_attachment_downloads_busy')
    }
    const attachment = this.db.messages.getAttachment(attachmentId, roomId)
    if (!this.manager.owns(attachment.localPath)) {
      throw new Error('room_attachment_path_invalid')
    }
    const byteLength = await this.manager.size(attachment.localPath)
    if ((this.roomGenerations.get(roomId) ?? 0) !== generation) {
      throw new Error('room_not_found')
    }
    const transferId = randomUUID()
    this.downloads.set(transferId, {
      roomId,
      path: attachment.localPath,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      byteLength,
      touchedAt: Date.now()
    })
    return {
      transferId,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      byteLength,
      chunkBytes: ROOM_ATTACHMENT_CHUNK_BYTES
    }
  }

  async readDownload(
    transferId: string,
    offset: number
  ): Promise<{
    contentBase64: string
    nextOffset: number
    done: boolean
  }> {
    const download = this.downloads.get(transferId)
    if (!download) {
      throw new Error('room_attachment_download_not_found')
    }
    if (Date.now() - download.touchedAt > DOWNLOAD_TTL_MS) {
      this.downloads.delete(transferId)
      throw new Error('room_attachment_download_expired')
    }
    download.touchedAt = Date.now()
    const read = this.manager.readChunk(download.path, offset)
    const active = this.activeReads.get(download.roomId) ?? new Set<Promise<unknown>>()
    active.add(read)
    this.activeReads.set(download.roomId, active)
    const release = (): void => {
      active.delete(read)
      if (active.size === 0) {
        this.activeReads.delete(download.roomId)
      }
    }
    return read.then(
      (result) => {
        release()
        return result
      },
      (error) => {
        release()
        throw error
      }
    )
  }

  downloadRoomId(transferId: string): string {
    const download = this.downloads.get(transferId)
    if (!download) {
      throw new Error('room_attachment_download_not_found')
    }
    return download.roomId
  }

  cancelDownload(transferId: string): void {
    this.downloads.delete(transferId)
  }

  async cancelRoom(roomId: string): Promise<string[]> {
    this.roomGenerations.set(roomId, (this.roomGenerations.get(roomId) ?? 0) + 1)
    const uploadIds = this.manager.pendingUploadIds(roomId)
    for (const [id, download] of this.downloads) {
      if (download.roomId === roomId) {
        this.downloads.delete(id)
      }
    }
    const activeReads = this.activeReads.get(roomId)
    if (activeReads) {
      await Promise.allSettled(activeReads)
    }
    await Promise.all(uploadIds.map((id) => this.manager.cancelUpload(id)))
    return uploadIds
  }

  removeRoomFiles(
    roomId: string,
    pendingUploadIds: string[],
    attachmentPaths: string[]
  ): Promise<void> {
    return this.manager.removeRoom(roomId, pendingUploadIds, attachmentPaths)
  }

  forgetRoom(roomId: string): void {
    this.roomGenerations.delete(roomId)
  }

  clear(): void {
    this.downloads.clear()
    this.activeReads.clear()
    this.roomGenerations.clear()
    this.manager.clear()
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [id, download] of this.downloads) {
      if (now - download.touchedAt > DOWNLOAD_TTL_MS) {
        this.downloads.delete(id)
      }
    }
  }
}
