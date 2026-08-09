import { randomUUID } from 'node:crypto'
import { O_NOFOLLOW, O_RDONLY } from 'node:constants'
import { appendFile, lstat, mkdir, open, realpath, rename, rm, unlink } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { RoomAttachment } from '../../../shared/rooms'
import { decodeCanonicalBase64 } from './canonical-base64'

export const ROOM_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024
export const ROOM_ATTACHMENT_CHUNK_BYTES = 384 * 1024
const MAX_ATTACHMENTS = 10
const MAX_PENDING_UPLOADS = 20
const MAX_PENDING_UPLOAD_BYTES = 500 * 1024 * 1024
const UPLOAD_TTL_MS = 10 * 60_000

type PendingUpload = {
  id: string
  roomId: string
  fileName: string
  byteSize: number
  path: string
  received: number
  ready: boolean
  busy: boolean
  cancelled: boolean
  touchedAt: number
  expiry: ReturnType<typeof setTimeout> | null
}

export class RoomAttachmentManager {
  private readonly root: string
  private readonly uploadsRoot: string
  private readonly uploads = new Map<string, PendingUpload>()
  private initialized: Promise<void> | null = null
  private canonicalRoot = ''

  constructor(root: string) {
    this.root = resolve(root)
    this.uploadsRoot = join(this.root, '.uploads')
  }

  async startUpload(roomId: string, fileName: string, byteSize: number): Promise<string> {
    await this.initialize()
    this.cleanupExpired()
    if (this.uploads.size >= MAX_PENDING_UPLOADS) {
      throw new Error('room_attachment_uploads_busy')
    }
    if (!Number.isInteger(byteSize) || byteSize < 0 || byteSize > ROOM_ATTACHMENT_MAX_BYTES) {
      throw new Error('room_attachment_too_large')
    }
    if (this.pendingBytes() + byteSize > MAX_PENDING_UPLOAD_BYTES) {
      throw new Error('room_attachment_uploads_busy')
    }
    const id = randomUUID()
    const path = join(this.uploadsRoot, `${id}.part`)
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
    const upload: PendingUpload = {
      id,
      roomId,
      fileName: safeName(fileName),
      byteSize,
      path,
      received: 0,
      ready: false,
      busy: false,
      cancelled: false,
      touchedAt: Date.now(),
      expiry: null
    }
    this.uploads.set(id, upload)
    this.touch(upload)
    return id
  }

  async appendUpload(id: string, offset: number, contentBase64: string): Promise<number> {
    const upload = this.pending(id)
    if (upload.ready || upload.busy || offset !== upload.received) {
      throw new Error('room_attachment_upload_state_invalid')
    }
    const chunk = decodeCanonicalBase64(contentBase64, ROOM_ATTACHMENT_CHUNK_BYTES)
    if (!chunk || upload.received + chunk.byteLength > upload.byteSize) {
      throw new Error('room_attachment_chunk_invalid')
    }
    upload.busy = true
    this.touch(upload)
    try {
      await appendFile(upload.path, chunk)
      if (upload.cancelled) {
        this.uploads.delete(id)
        await unlink(upload.path).catch(() => undefined)
        throw new Error('room_attachment_upload_not_found')
      }
      upload.received += chunk.byteLength
      this.touch(upload)
      return upload.received
    } finally {
      upload.busy = false
    }
  }

  finishUpload(id: string): void {
    const upload = this.pending(id)
    if (upload.busy || upload.received !== upload.byteSize) {
      throw new Error('room_attachment_upload_incomplete')
    }
    upload.ready = true
    this.touch(upload)
  }

  async consumeUploads(roomId: string, ids: string[]): Promise<RoomAttachment[]> {
    if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) {
      throw new Error('room_attachment_count_exceeded')
    }
    const uploads = ids.map((id) => this.pending(id))
    if (uploads.some((upload) => !upload.ready || upload.roomId !== roomId || upload.busy)) {
      throw new Error('room_attachment_upload_state_invalid')
    }
    for (const upload of uploads) {
      if (upload.expiry) {
        clearTimeout(upload.expiry)
      }
      this.uploads.delete(upload.id)
    }
    const directory = join(this.root, roomId)
    await mkdir(directory, { recursive: true })
    const attachments: RoomAttachment[] = []
    try {
      for (const upload of uploads) {
        const destination = join(directory, `${upload.id}${extname(upload.fileName).slice(0, 20)}`)
        await rename(upload.path, destination)
        attachments.push({
          id: upload.id,
          messageId: '',
          fileName: upload.fileName,
          mimeType: mimeType(upload.fileName),
          byteSize: upload.byteSize,
          localPath: destination,
          createdAt: Date.now()
        })
      }
      return attachments
    } catch (error) {
      await this.remove([
        ...uploads.map((upload) => upload.path),
        ...attachments.map((attachment) => attachment.localPath)
      ])
      throw error
    }
  }

  async cancelUpload(id: string): Promise<void> {
    const upload = this.uploads.get(id)
    if (!upload) {
      return
    }
    upload.cancelled = true
    if (upload.expiry) {
      clearTimeout(upload.expiry)
    }
    if (upload.busy) {
      return
    }
    this.uploads.delete(id)
    await unlink(upload.path).catch(() => undefined)
  }

  async remove(paths: string[]): Promise<void> {
    await Promise.all(
      paths.filter((path) => this.owns(path)).map((path) => unlink(path).catch(() => undefined))
    )
  }

  clear(): void {
    for (const id of this.uploads.keys()) {
      void this.cancelUpload(id)
    }
  }

  owns(path: string): boolean {
    const candidate = resolve(path)
    return candidate.startsWith(`${this.root}${sep}`)
  }

  async size(path: string): Promise<number> {
    const { handle, size } = await this.openOwned(path)
    await handle.close()
    return size
  }

  async read(path: string): Promise<Buffer> {
    const { handle } = await this.openOwned(path)
    try {
      return await handle.readFile()
    } finally {
      await handle.close()
    }
  }

  async readChunk(
    path: string,
    offset: number
  ): Promise<{ contentBase64: string; nextOffset: number; done: boolean }> {
    const { handle, size } = await this.openOwned(path)
    if (!Number.isInteger(offset) || offset < 0 || offset > size) {
      await handle.close()
      throw new Error('room_attachment_offset_invalid')
    }
    const length = Math.min(ROOM_ATTACHMENT_CHUNK_BYTES, size - offset)
    const buffer = Buffer.allocUnsafe(length)
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      const nextOffset = offset + bytesRead
      return {
        contentBase64: buffer.subarray(0, bytesRead).toString('base64'),
        nextOffset,
        done: nextOffset === size
      }
    } finally {
      await handle.close()
    }
  }

  private pending(id: string): PendingUpload {
    const upload = this.uploads.get(id)
    if (!upload) {
      throw new Error('room_attachment_upload_not_found')
    }
    if (Date.now() - upload.touchedAt > UPLOAD_TTL_MS) {
      void this.cancelUpload(id)
      throw new Error('room_attachment_upload_expired')
    }
    return upload
  }

  private cleanupExpired(): void {
    const now = Date.now()
    for (const [id, upload] of this.uploads) {
      if (now - upload.touchedAt > UPLOAD_TTL_MS) {
        void this.cancelUpload(id)
      }
    }
  }

  private pendingBytes(): number {
    let total = 0
    for (const upload of this.uploads.values()) {
      total += upload.byteSize
    }
    return total
  }

  private touch(upload: PendingUpload): void {
    if (upload.cancelled) {
      return
    }
    upload.touchedAt = Date.now()
    if (upload.expiry) {
      clearTimeout(upload.expiry)
    }
    upload.expiry = setTimeout(() => void this.cancelUpload(upload.id), UPLOAD_TTL_MS)
    upload.expiry.unref?.()
  }

  private async openOwned(
    path: string
  ): Promise<{ handle: Awaited<ReturnType<typeof open>>; size: number }> {
    await this.initialize()
    if (!this.owns(path)) {
      throw new Error('room_attachment_path_invalid')
    }
    const pathStats = await lstat(path)
    if (pathStats.isSymbolicLink()) {
      throw new Error('room_attachment_not_file')
    }
    const source = await realpath(path)
    if (!source.startsWith(`${this.canonicalRoot}${sep}`)) {
      throw new Error('room_attachment_path_invalid')
    }
    const handle = await open(source, O_RDONLY | O_NOFOLLOW)
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > ROOM_ATTACHMENT_MAX_BYTES) {
      await handle.close()
      throw new Error('room_attachment_not_file')
    }
    return { handle, size: stats.size }
  }

  private initialize(): Promise<void> {
    this.initialized ??= rm(this.uploadsRoot, { recursive: true, force: true }).then(async () => {
      await mkdir(this.uploadsRoot, { recursive: true })
      this.canonicalRoot = await realpath(this.root)
    })
    return this.initialized
  }
}

function safeName(value: string): string {
  const cleaned = value.replace(/[\p{Cc}<>:"/\\|?*]/gu, '_').trim()
  return (cleaned || 'attachment').slice(0, 240)
}

function mimeType(fileName: string): string {
  const extension = extname(fileName).toLowerCase()
  return (
    (
      {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.json': 'application/json',
        '.md': 'text/markdown',
        '.txt': 'text/plain'
      } as Record<string, string>
    )[extension] ?? 'application/octet-stream'
  )
}
