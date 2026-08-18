import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { SKILL_PACKAGE_MAX_COMPRESSED_BYTES } from '../../shared/skill-package-manifest'
import {
  SKILL_UPLOAD_CHUNK_MAX_BYTES,
  type SkillUploadBeginRequest,
  type SkillUploadBeginResult,
  type SkillUploadChunkRequest
} from '../../shared/skill-upload-session-contract'

const MAX_SESSIONS = 4
const SESSION_IDLE_MS = 10 * 60_000

type UploadSession = {
  id: string
  path: string
  package: SkillUploadBeginRequest['package']
  transferId: string | null
  handle: FileHandle | null
  idleTimer: ReturnType<typeof setTimeout> | null
  bytesReceived: number
  touchedAt: number
  committed: boolean
}

export class SkillUploadSessionService {
  private readonly sessions = new Map<string, UploadSession>()
  private initialized: Promise<void> | null = null
  private readonly idleMs: number

  constructor(
    private readonly root: string,
    private readonly options: { idleMs?: number; initializeRoot?: () => Promise<void> } = {}
  ) {
    this.idleMs = options.idleMs ?? SESSION_IDLE_MS
  }

  async begin(request: SkillUploadBeginRequest): Promise<SkillUploadBeginResult> {
    await this.initialize()
    await this.prune()
    const existing = request.transferId
      ? [...this.sessions.values()].find((session) => session.transferId === request.transferId)
      : undefined
    if (existing) {
      if (JSON.stringify(existing.package) !== JSON.stringify(request.package)) {
        throw new Error('skill-upload-transfer-mismatch')
      }
      this.touch(existing)
      return this.beginResult(existing)
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error('skill-upload-session-limit')
    }
    const id = randomUUID()
    const path = join(this.root, `${id}.tar.gz`)
    const handle = await open(path, 'wx+', 0o600)
    const session: UploadSession = {
      id,
      path,
      package: request.package,
      transferId: request.transferId ?? null,
      handle,
      idleTimer: null,
      bytesReceived: 0,
      touchedAt: Date.now(),
      committed: false
    }
    this.sessions.set(id, session)
    this.touch(session)
    return this.beginResult(session)
  }

  async append(request: SkillUploadChunkRequest): Promise<{ acknowledgedOffset: number }> {
    const session = await this.requireActive(request.uploadId)
    const bytes = Buffer.from(request.bytesBase64, 'base64')
    if (
      bytes.length === 0 ||
      bytes.length > SKILL_UPLOAD_CHUNK_MAX_BYTES ||
      bytes.toString('base64') !== request.bytesBase64
    ) {
      throw new Error('skill-upload-chunk-invalid')
    }
    if (request.offset > session.bytesReceived) {
      throw new Error('skill-upload-offset-invalid')
    }
    if (request.offset < session.bytesReceived) {
      if (request.offset + bytes.length > session.bytesReceived || !session.handle) {
        throw new Error('skill-upload-offset-invalid')
      }
      const existing = Buffer.alloc(bytes.length)
      const read = await session.handle.read(existing, 0, existing.length, request.offset)
      if (read.bytesRead !== bytes.length || !existing.equals(bytes)) {
        throw new Error('skill-upload-retry-mismatch')
      }
      this.touch(session)
      return { acknowledgedOffset: session.bytesReceived }
    }
    if (session.bytesReceived + bytes.length > session.package.compressedBytes) {
      throw new Error('skill-upload-size-limit')
    }
    const write = await session.handle!.write(bytes, 0, bytes.length, request.offset)
    if (write.bytesWritten !== bytes.length) {
      throw new Error('skill-upload-write-incomplete')
    }
    session.bytesReceived += bytes.length
    this.touch(session)
    return { acknowledgedOffset: session.bytesReceived }
  }

  async commit(uploadId: string): Promise<{ uploadId: string }> {
    const session = this.sessions.get(uploadId)
    if (!session) {
      throw new Error('skill-upload-session-unavailable')
    }
    if (this.expired(session)) {
      await this.cancel(uploadId)
      throw new Error('skill-upload-session-unavailable')
    }
    if (session.committed) {
      this.touch(session)
      return { uploadId }
    }
    if (session.bytesReceived !== session.package.compressedBytes || !session.handle) {
      throw new Error('skill-upload-size-mismatch')
    }
    await session.handle.sync()
    await session.handle.close()
    session.handle = null
    const identity = await this.hash(session.path)
    if (identity !== session.package.archiveSha256) {
      await this.cancel(uploadId)
      throw new Error('skill-upload-archive-hash-mismatch')
    }
    session.committed = true
    this.touch(session)
    return { uploadId }
  }

  async take(
    uploadId: string,
    identity: SkillUploadBeginRequest['package']
  ): Promise<{ archivePath: string; cleanup(): Promise<void> }> {
    const session = this.sessions.get(uploadId)
    if (!session) {
      throw new Error('skill-upload-session-unavailable')
    }
    if (this.expired(session)) {
      await this.cancel(uploadId)
      throw new Error('skill-upload-session-unavailable')
    }
    if (!session.committed || JSON.stringify(session.package) !== JSON.stringify(identity)) {
      throw new Error('skill-upload-session-unavailable')
    }
    this.sessions.delete(uploadId)
    this.clearIdleTimer(session)
    let cleaned = false
    return {
      archivePath: session.path,
      cleanup: async () => {
        if (cleaned) {
          return
        }
        cleaned = true
        await rm(session.path, { force: true })
      }
    }
  }

  async cancel(uploadId: string): Promise<void> {
    const session = this.sessions.get(uploadId)
    if (!session) {
      return
    }
    this.sessions.delete(uploadId)
    this.clearIdleTimer(session)
    await session.handle?.close().catch(() => undefined)
    await rm(session.path, { force: true })
  }

  private async requireActive(uploadId: string): Promise<UploadSession> {
    const session = this.sessions.get(uploadId)
    if (!session || session.committed) {
      throw new Error('skill-upload-session-unavailable')
    }
    if (this.expired(session)) {
      await this.cancel(uploadId)
      throw new Error('skill-upload-session-unavailable')
    }
    return session
  }

  private expired(session: UploadSession): boolean {
    return Date.now() - session.touchedAt >= this.idleMs
  }

  private beginResult(session: UploadSession): SkillUploadBeginResult {
    return {
      uploadId: session.id,
      chunkBytes: SKILL_UPLOAD_CHUNK_MAX_BYTES,
      acknowledgedOffset: session.bytesReceived
    }
  }

  private touch(session: UploadSession): void {
    session.touchedAt = Date.now()
    this.clearIdleTimer(session)
    session.idleTimer = setTimeout(() => {
      void this.cancel(session.id).catch(() => undefined)
    }, this.idleMs)
    session.idleTimer.unref()
  }

  private clearIdleTimer(session: UploadSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
  }

  private async initialize(): Promise<void> {
    if (!this.initialized) {
      const initialization = (async () => {
        if (this.options.initializeRoot) {
          await this.options.initializeRoot()
        } else {
          await rm(this.root, { recursive: true, force: true })
          await mkdir(this.root, { recursive: true, mode: 0o700 })
        }
      })()
      this.initialized = initialization
      void initialization.catch(() => {
        if (this.initialized === initialization) {
          this.initialized = null
        }
      })
    }
    await this.initialized
  }

  private async prune(): Promise<void> {
    const expired = [...this.sessions.values()]
      .filter((session) => this.expired(session))
      .map((session) => session.id)
    await Promise.all(expired.map((id) => this.cancel(id)))
  }

  private async hash(path: string): Promise<string> {
    const size = (await stat(path)).size
    if (size < 1 || size > SKILL_PACKAGE_MAX_COMPRESSED_BYTES) {
      throw new Error('skill-upload-size-limit')
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer)
    }
    return hash.digest('hex')
  }
}
