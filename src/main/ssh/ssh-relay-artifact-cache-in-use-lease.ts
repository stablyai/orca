import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { SshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry-verification'
import { SSH_RELAY_ARTIFACT_CACHE_IN_USE_STALE_AFTER_MS } from './ssh-relay-artifact-cache-in-use-inspection'
import {
  readSshRelayArtifactCacheInUseOwner,
  sameSshRelayArtifactCacheInUseDirectory,
  sshRelayArtifactCacheInUseOwnerBytes,
  SSH_RELAY_ARTIFACT_CACHE_IN_USE_SCHEMA_VERSION,
  type SshRelayArtifactCacheInUseDirectoryIdentity,
  type SshRelayArtifactCacheInUseOwner
} from './ssh-relay-artifact-cache-in-use-record'
import { acquireSshRelayArtifactCacheLock } from './ssh-relay-artifact-cache-lock'
import { sshRelayArtifactCacheErrorCode } from './ssh-relay-artifact-cache-lock-record'
import { recordSshRelayArtifactCacheRecency } from './ssh-relay-artifact-cache-recency'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

const HEARTBEAT_INTERVAL_MS = 5_000
const ACQUISITION_TIMEOUT_MS = 120_000
const CONTENT_ID = /^sha256:([0-9a-f]{64})$/
const TOKEN = /^[0-9a-f]{32}$/

function exactContentHex(contentId: SshRelayDigest): string {
  const match = CONTENT_ID.exec(contentId)
  if (!match) {
    throw new Error('SSH relay artifact cache in-use content ID must be an exact lowercase digest')
  }
  return match[1]
}

export function sshRelayArtifactCacheInUseLeasePath(
  cacheRoot: string,
  contentId: SshRelayDigest,
  token: string
): string {
  if (!TOKEN.test(token)) {
    throw new Error('SSH relay artifact cache in-use token must be exact lowercase hex')
  }
  return resolve(cacheRoot, 'in-use', exactContentHex(contentId), `${token}.lease`)
}

async function writeCompleteOwner(handle: FileHandle, owner: SshRelayArtifactCacheInUseOwner) {
  const bytes = sshRelayArtifactCacheInUseOwnerBytes(owner)
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
    if (bytesWritten <= 0) {
      throw new Error('SSH relay artifact cache in-use heartbeat could not be persisted')
    }
    offset += bytesWritten
  }
  await handle.truncate(bytes.length)
  await handle.sync()
}

class SshRelayArtifactCacheInUseLeaseOwner {
  readonly leasePath: string
  readonly token: string
  private readonly cacheRoot: string
  private readonly contentId: SshRelayDigest
  private readonly directory: SshRelayArtifactCacheInUseDirectoryIdentity
  private readonly ownerHandle: FileHandle
  private readonly owner: SshRelayArtifactCacheInUseOwner
  private heartbeat: Promise<void> = Promise.resolve()
  private heartbeatError: unknown
  private heartbeatTimer: NodeJS.Timeout | undefined
  private released = false

  constructor(options: {
    cacheRoot: string
    leasePath: string
    contentId: SshRelayDigest
    token: string
    directory: SshRelayArtifactCacheInUseDirectoryIdentity
    ownerHandle: FileHandle
    owner: SshRelayArtifactCacheInUseOwner
  }) {
    this.cacheRoot = options.cacheRoot
    this.leasePath = options.leasePath
    this.contentId = options.contentId
    this.token = options.token
    this.directory = options.directory
    this.ownerHandle = options.ownerHandle
    this.owner = options.owner
    this.heartbeatTimer = setInterval(() => this.queueHeartbeat(), HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref()
  }

  private queueHeartbeat(): void {
    this.heartbeat = this.heartbeat.then(async () => {
      if (this.released || this.heartbeatError) {
        return
      }
      try {
        await this.assertPathOwnership()
        this.owner.heartbeatAtMs = Date.now()
        await writeCompleteOwner(this.ownerHandle, this.owner)
      } catch (error) {
        this.heartbeatError = error
      }
    })
  }

  private async assertPathOwnership(): Promise<void> {
    const metadata = await lstat(this.leasePath, { bigint: true }).catch(() => null)
    const current = await readSshRelayArtifactCacheInUseOwner(
      this.leasePath,
      this.contentId,
      this.token
    )
    if (
      !metadata?.isDirectory() ||
      !sameSshRelayArtifactCacheInUseDirectory(this.directory, metadata) ||
      current?.token !== this.token
    ) {
      throw new Error('SSH relay artifact cache in-use ownership was displaced')
    }
  }

  async assertOwned(): Promise<void> {
    await this.heartbeat
    if (this.released || this.heartbeatError) {
      throw new Error('SSH relay artifact cache in-use ownership is no longer active', {
        cause: this.heartbeatError
      })
    }
    await this.assertPathOwnership()
  }

  async release(): Promise<void> {
    if (this.released) {
      return
    }
    this.released = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
    }
    this.heartbeatTimer = undefined
    await this.heartbeat
    let owned = false
    try {
      await this.assertPathOwnership()
      owned = true
    } catch {
      // A displaced lease must never remove another process's visible reference.
    }
    await this.ownerHandle.close()
    if (!owned) {
      return
    }
    const tombstone = `${this.leasePath}.released-${this.token}`
    await rename(this.leasePath, tombstone)
    await rm(tombstone, { recursive: true, force: true })
    await recordSshRelayArtifactCacheRecency({
      cacheRoot: this.cacheRoot,
      contentId: this.contentId
    })
  }
}

export type SshRelayArtifactCacheInUseLease = Pick<
  SshRelayArtifactCacheInUseLeaseOwner,
  'leasePath' | 'token' | 'assertOwned' | 'release'
>

async function createLease(
  cacheRoot: string,
  contentId: SshRelayDigest
): Promise<SshRelayArtifactCacheInUseLease> {
  const token = randomBytes(16).toString('hex')
  const leasePath = sshRelayArtifactCacheInUseLeasePath(cacheRoot, contentId, token)
  await mkdir(dirname(leasePath), { recursive: true, mode: 0o700 })
  await mkdir(leasePath, { mode: 0o700 })
  let handle: FileHandle | undefined
  try {
    handle = await open(join(leasePath, 'owner.json'), 'wx+', 0o600)
    const now = Date.now()
    const owner: SshRelayArtifactCacheInUseOwner = {
      schemaVersion: SSH_RELAY_ARTIFACT_CACHE_IN_USE_SCHEMA_VERSION,
      contentId,
      token,
      hostname: hostname(),
      pid: process.pid,
      acquiredAtMs: now,
      heartbeatAtMs: now
    }
    await writeCompleteOwner(handle, owner)
    const directory = await lstat(leasePath, { bigint: true })
    return new SshRelayArtifactCacheInUseLeaseOwner({
      cacheRoot,
      leasePath,
      contentId,
      token,
      directory,
      ownerHandle: handle,
      owner
    })
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(leasePath, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function acquireSshRelayArtifactCacheInUseLease({
  cacheRoot,
  entry,
  signal
}: {
  cacheRoot: string
  entry: SshRelayArtifactCacheEntry
  signal?: AbortSignal
}): Promise<SshRelayArtifactCacheInUseLease> {
  const timeout = AbortSignal.timeout(ACQUISITION_TIMEOUT_MS)
  const activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  activeSignal.throwIfAborted()
  // Why: publication returns physical entry paths, so logical aliases such as macOS /var must be
  // canonicalized before exact identity checks and all lease-owned writes.
  const physicalCacheRoot = await realpath(resolve(cacheRoot))
  const expectedPath = resolve(physicalCacheRoot, 'entries', exactContentHex(entry.contentId))
  const physicalEntryPath = await realpath(resolve(entry.entryPath)).catch((error) => {
    if (sshRelayArtifactCacheErrorCode(error) === 'ENOENT') {
      throw new Error('SSH relay artifact cache in-use entry no longer exists', { cause: error })
    }
    throw error
  })
  if (physicalEntryPath !== expectedPath) {
    throw new Error(
      'SSH relay artifact cache in-use entry path disagrees with its content identity'
    )
  }
  const lock = await acquireSshRelayArtifactCacheLock({
    cacheRoot: physicalCacheRoot,
    contentId: entry.contentId,
    signal: activeSignal
  })
  try {
    const metadata = await lstat(expectedPath).catch((error) => {
      if (sshRelayArtifactCacheErrorCode(error) === 'ENOENT') {
        throw new Error('SSH relay artifact cache in-use entry no longer exists', { cause: error })
      }
      throw error
    })
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('SSH relay artifact cache in-use entry is not a complete final directory')
    }
    const lease = await createLease(physicalCacheRoot, entry.contentId)
    try {
      await recordSshRelayArtifactCacheRecency({
        cacheRoot: physicalCacheRoot,
        contentId: entry.contentId
      })
      return lease
    } catch (error) {
      await lease.release().catch(() => {})
      throw error
    }
  } finally {
    await lock.release()
  }
}

export const SSH_RELAY_ARTIFACT_CACHE_IN_USE_LIMITS = Object.freeze({
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  staleAfterMs: SSH_RELAY_ARTIFACT_CACHE_IN_USE_STALE_AFTER_MS,
  acquisitionTimeoutMs: ACQUISITION_TIMEOUT_MS
})
