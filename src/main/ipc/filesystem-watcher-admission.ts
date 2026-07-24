import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export const FILESYSTEM_WATCHER_MAX_CLAIMS = 1_024
export const FILESYSTEM_WATCHER_MAX_CLAIMS_PER_SENDER = 256
export const FILESYSTEM_WATCHER_MAX_RETAINED_IDENTITY_BYTES = 16 * 1024 * 1024
export const FILESYSTEM_WATCHER_MAX_PATH_BYTES = 64 * 1024
export const FILESYSTEM_WATCHER_MAX_CONNECTION_ID_BYTES = 8 * 1024

type WatchClaim = { retainedBytes: number }

export type FilesystemWatcherIdentity = {
  worktreePath: string
  connectionId?: string
  retainedBytes: number
}

export class FilesystemWatcherAdmission {
  private readonly claimsBySender = new Map<number, Map<string, WatchClaim>>()
  private claimCount = 0
  private retainedBytes = 0

  claim(
    senderId: number,
    key: string,
    retainedBytes: number
  ): { added: boolean; release: () => void } {
    let senderClaims = this.claimsBySender.get(senderId)
    const existing = senderClaims?.get(key)
    if (existing) {
      return { added: false, release: () => undefined }
    }
    if (
      this.claimCount >= FILESYSTEM_WATCHER_MAX_CLAIMS ||
      (senderClaims?.size ?? 0) >= FILESYSTEM_WATCHER_MAX_CLAIMS_PER_SENDER ||
      this.retainedBytes + retainedBytes > FILESYSTEM_WATCHER_MAX_RETAINED_IDENTITY_BYTES
    ) {
      throw new Error('Filesystem watcher capacity reached; close an existing watch and retry.')
    }
    senderClaims ??= new Map()
    this.claimsBySender.set(senderId, senderClaims)
    const claim = { retainedBytes }
    senderClaims.set(key, claim)
    this.claimCount += 1
    this.retainedBytes += retainedBytes
    return {
      added: true,
      release: () => this.releaseClaim(senderId, key, claim)
    }
  }

  release(senderId: number, key: string): void {
    const claim = this.claimsBySender.get(senderId)?.get(key)
    if (claim) {
      this.releaseClaim(senderId, key, claim)
    }
  }

  releaseSender(senderId: number): void {
    const senderClaims = this.claimsBySender.get(senderId)
    if (!senderClaims) {
      return
    }
    this.claimsBySender.delete(senderId)
    for (const claim of senderClaims.values()) {
      this.claimCount -= 1
      this.retainedBytes -= claim.retainedBytes
    }
  }

  clear(): void {
    this.claimsBySender.clear()
    this.claimCount = 0
    this.retainedBytes = 0
  }

  evidence(): { claimCount: number; retainedBytes: number; senderCount: number } {
    return {
      claimCount: this.claimCount,
      retainedBytes: this.retainedBytes,
      senderCount: this.claimsBySender.size
    }
  }

  private releaseClaim(senderId: number, key: string, expected: WatchClaim): void {
    const senderClaims = this.claimsBySender.get(senderId)
    if (senderClaims?.get(key) !== expected) {
      return
    }
    senderClaims.delete(key)
    this.claimCount -= 1
    this.retainedBytes -= expected.retainedBytes
    if (senderClaims.size === 0) {
      this.claimsBySender.delete(senderId)
    }
  }
}

export function parseFilesystemWatcherIdentity(value: unknown): FilesystemWatcherIdentity {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Filesystem watcher arguments are required.')
  }
  const record = value as Record<string, unknown>
  const worktreePath = record.worktreePath
  const connectionId = record.connectionId
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    throw new TypeError('Filesystem watcher worktreePath must be a non-empty string.')
  }
  const pathBytes = boundedFieldBytes(
    worktreePath,
    FILESYSTEM_WATCHER_MAX_PATH_BYTES,
    'worktreePath'
  )
  if (connectionId !== undefined && typeof connectionId !== 'string') {
    throw new TypeError('Filesystem watcher connectionId must be a string.')
  }
  const connectionBytes = connectionId
    ? boundedFieldBytes(connectionId, FILESYSTEM_WATCHER_MAX_CONNECTION_ID_BYTES, 'connectionId')
    : 0
  return {
    worktreePath,
    ...(connectionId ? { connectionId } : {}),
    retainedBytes: pathBytes + connectionBytes
  }
}

function boundedFieldBytes(value: string, limit: number, field: string): number {
  const measured = measureUtf8ByteLength(value, { stopAfterBytes: limit })
  if (measured.exceededLimit) {
    throw new TypeError(`Filesystem watcher ${field} exceeds ${limit} UTF-8 bytes.`)
  }
  return measured.byteLength
}
