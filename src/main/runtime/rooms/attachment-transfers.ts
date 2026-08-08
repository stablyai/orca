import { randomUUID } from 'node:crypto'
import type { RoomDatabase } from './database'
import type { RoomAttachmentManager } from './attachments'
import { ROOM_ATTACHMENT_CHUNK_BYTES } from './attachments'

const DOWNLOAD_TTL_MS = 5 * 60_000
const MAX_DOWNLOADS = 10

type Download = {
  path: string
  fileName: string
  mimeType: string
  byteLength: number
  touchedAt: number
}

export class RoomAttachmentTransferStore {
  private readonly downloads = new Map<string, Download>()

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
    return {
      uploadId: await this.manager.startUpload(roomId, fileName, byteSize),
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
    this.cleanup()
    if (this.downloads.size >= MAX_DOWNLOADS) {
      throw new Error('room_attachment_downloads_busy')
    }
    const attachment = this.db.messages.getAttachment(attachmentId, roomId)
    if (!this.manager.owns(attachment.localPath)) {
      throw new Error('room_attachment_path_invalid')
    }
    const byteLength = await this.manager.size(attachment.localPath)
    const transferId = randomUUID()
    this.downloads.set(transferId, {
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
    return this.manager.readChunk(download.path, offset)
  }

  cancelDownload(transferId: string): void {
    this.downloads.delete(transferId)
  }

  clear(): void {
    this.downloads.clear()
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
