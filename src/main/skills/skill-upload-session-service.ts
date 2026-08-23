import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SKILL_UPLOAD_CHUNK_MAX_BYTES,
  type SkillUploadBeginRequest,
  type SkillUploadBeginResult,
  type SkillUploadChunkRequest
} from '../../shared/skill-upload-session-contract'
import { SkillUploadStagingOwnership } from './skill-upload-staging-ownership'
import { hashSkillUploadArchive } from './skill-upload-archive-hash'
import { SkillUploadOperationLifecycle } from './skill-upload-operation-lifecycle'
import { SkillUploadRetainedPaths } from './skill-upload-retained-paths'
import type { SkillUploadSessionServiceOptions } from './skill-upload-session-service-options'
import {
  createSkillUploadSessionRecord,
  skillUploadBeginResult,
  type SkillUploadSessionRecord
} from './skill-upload-session-record'

const MAX_SESSIONS = 4
const SESSION_IDLE_MS = 10 * 60_000

export class SkillUploadSessionService {
  private readonly sessions = new Map<string, SkillUploadSessionRecord>()
  private initialized: Promise<void> | null = null
  private readonly idleMs: number
  private readonly ownership: SkillUploadStagingOwnership
  private readonly retainedPaths = new SkillUploadRetainedPaths()
  private readonly operations = new SkillUploadOperationLifecycle()
  private disposal: Promise<void> | null = null
  private disposed = false

  constructor(
    root: string,
    private readonly options: SkillUploadSessionServiceOptions = {}
  ) {
    this.idleMs = options.idleMs ?? SESSION_IDLE_MS
    this.ownership = new SkillUploadStagingOwnership(root, options.ownership)
  }

  async begin(request: SkillUploadBeginRequest): Promise<SkillUploadBeginResult> {
    const leaveOperation = await this.operations.enterBegin(() => this.assertAvailable())
    try {
      await this.initialize()
      await this.prune()
      this.assertAvailable()
      const existing = request.transferId
        ? [...this.sessions.values()].find((session) => session.transferId === request.transferId)
        : undefined
      if (existing) {
        if (JSON.stringify(existing.package) !== JSON.stringify(request.package)) {
          throw new Error('skill-upload-transfer-mismatch')
        }
        this.touch(existing)
        return skillUploadBeginResult(existing)
      }
      if (this.sessions.size + this.retainedPaths.failedCleanupCount >= MAX_SESSIONS) {
        await this.retainedPaths.retryFailedCleanup()
      }
      this.assertAvailable()
      if (this.sessions.size + this.retainedPaths.failedCleanupCount >= MAX_SESSIONS) {
        throw new Error('skill-upload-session-limit')
      }
      const id = randomUUID()
      const path = join(this.ownership.directory, `${id}.tar.gz`)
      const handle = await open(path, 'wx+', 0o600)
      try {
        this.assertAvailable()
      } catch (error) {
        await this.retainedPaths.removeUnpublished(path, () => handle.close())
        throw error
      }
      const session = createSkillUploadSessionRecord(id, path, request, handle)
      this.sessions.set(id, session)
      this.touch(session)
      return skillUploadBeginResult(session)
    } finally {
      leaveOperation()
      await this.removeOwnershipIfDisposed()
    }
  }

  async append(request: SkillUploadChunkRequest): Promise<{ acknowledgedOffset: number }> {
    const leaveOperation = this.operations.enter(() => this.assertAvailable())
    try {
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
      const handle = session.handle
      if (!handle) {
        throw new Error('skill-upload-session-unavailable')
      }
      const write = await handle.write(bytes, 0, bytes.length, request.offset)
      if (write.bytesWritten !== bytes.length) {
        throw new Error('skill-upload-write-incomplete')
      }
      session.bytesReceived += bytes.length
      this.touch(session)
      return { acknowledgedOffset: session.bytesReceived }
    } finally {
      leaveOperation()
    }
  }

  async commit(uploadId: string): Promise<{ uploadId: string }> {
    const leaveOperation = this.operations.enter(() => this.assertAvailable())
    try {
      const session = this.sessions.get(uploadId)
      if (!session) {
        throw new Error('skill-upload-session-unavailable')
      }
      if (this.expired(session)) {
        await this.cancelSession(uploadId)
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
      let identity: string
      try {
        identity = await (this.options.hashArchive ?? hashSkillUploadArchive)(session.path)
      } catch (error) {
        await this.cancelSession(uploadId).catch(() => undefined)
        throw error
      }
      if (identity !== session.package.archiveSha256) {
        await this.cancelSession(uploadId)
        throw new Error('skill-upload-archive-hash-mismatch')
      }
      session.committed = true
      this.touch(session)
      return { uploadId }
    } finally {
      leaveOperation()
    }
  }

  async take(
    uploadId: string,
    identity: SkillUploadBeginRequest['package']
  ): Promise<{ archivePath: string; cleanup(): Promise<void> }> {
    const leaveOperation = this.operations.enter(() => this.assertAvailable())
    try {
      const session = this.sessions.get(uploadId)
      if (!session) {
        throw new Error('skill-upload-session-unavailable')
      }
      if (this.expired(session)) {
        await this.cancelSession(uploadId)
        throw new Error('skill-upload-session-unavailable')
      }
      if (!session.committed || JSON.stringify(session.package) !== JSON.stringify(identity)) {
        throw new Error('skill-upload-session-unavailable')
      }
      this.sessions.delete(uploadId)
      this.clearIdleTimer(session)
      this.retainedPaths.retainTransferred(session.path)
      let cleanup: Promise<void> | null = null
      return {
        archivePath: session.path,
        cleanup: async () => {
          if (!cleanup) {
            cleanup = this.cleanupRetainedPath(session.path).catch((error) => {
              cleanup = null
              throw error
            })
          }
          await cleanup
        }
      }
    } finally {
      leaveOperation()
    }
  }

  async cancel(uploadId: string): Promise<void> {
    if (this.disposed) {
      return
    }
    const leaveOperation = this.operations.enter(() => this.assertAvailable())
    try {
      await this.cancelSession(uploadId)
    } finally {
      leaveOperation()
    }
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true
      this.disposal = this.disposeOwnedStaging()
    }
    return this.disposal
  }

  private async disposeOwnedStaging(): Promise<void> {
    await this.operations.settle()
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.cancelSession(id)))
    await this.retainedPaths.removeAllFailedCleanup()
    await this.removeOwnershipIfDisposed()
  }

  private async cancelSession(uploadId: string): Promise<void> {
    const session = this.sessions.get(uploadId)
    if (!session) {
      return
    }
    this.sessions.delete(uploadId)
    this.clearIdleTimer(session)
    this.retainedPaths.retainFailedCleanup(session.path)
    await session.handle?.close().catch(() => undefined)
    await this.retainedPaths.removeFailedCleanup(session.path)
  }

  private async requireActive(uploadId: string): Promise<SkillUploadSessionRecord> {
    const session = this.sessions.get(uploadId)
    if (!session || session.committed) {
      throw new Error('skill-upload-session-unavailable')
    }
    if (this.expired(session)) {
      await this.cancelSession(uploadId)
      throw new Error('skill-upload-session-unavailable')
    }
    return session
  }

  private expired(session: SkillUploadSessionRecord): boolean {
    return Date.now() - session.touchedAt >= this.idleMs
  }

  private touch(session: SkillUploadSessionRecord): void {
    session.touchedAt = Date.now()
    this.clearIdleTimer(session)
    session.idleTimer = setTimeout(() => {
      void this.cancel(session.id).catch(() => undefined)
    }, this.idleMs)
    session.idleTimer.unref()
  }

  private clearIdleTimer(session: SkillUploadSessionRecord): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
  }

  private async initialize(): Promise<void> {
    if (!this.initialized) {
      const initialization = this.ownership.initialize(this.options.initializeRoot)
      this.initialized = initialization
      void initialization.catch(() => {
        if (this.initialized === initialization) {
          this.initialized = null
        }
      })
    }
    await this.initialized
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new Error('skill-upload-service-disposed')
    }
  }

  private async removeOwnershipIfDisposed(): Promise<void> {
    if (
      this.disposed &&
      !this.operations.hasInFlight &&
      this.sessions.size === 0 &&
      this.retainedPaths.isEmpty
    ) {
      await this.ownership.remove()
    }
  }

  private async cleanupRetainedPath(path: string): Promise<void> {
    await this.retainedPaths.removeTransferred(path)
    await this.removeOwnershipIfDisposed()
  }

  private async prune(): Promise<void> {
    const expired = [...this.sessions.values()]
      .filter((session) => this.expired(session))
      .map((session) => session.id)
    await Promise.all(expired.map((id) => this.cancel(id)))
  }
}
