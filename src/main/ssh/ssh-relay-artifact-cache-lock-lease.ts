import { lstat, type FileHandle } from 'node:fs/promises'

import { releaseSshRelayArtifactCacheLockPath } from './ssh-relay-artifact-cache-lock-release'

import {
  readSshRelayArtifactCacheLockOwner,
  sameSshRelayArtifactCacheLockDirectory,
  sshRelayArtifactCacheErrorCode,
  sshRelayArtifactCacheLockOwnerBytes,
  type SshRelayArtifactCacheLockDirectoryIdentity,
  type SshRelayArtifactCacheLockOwnerRecord
} from './ssh-relay-artifact-cache-lock-record'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

export const SSH_RELAY_ARTIFACT_CACHE_HEARTBEAT_INTERVAL_MS = 5_000

async function writeCompleteRecord(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
    if (bytesWritten <= 0) {
      throw new Error('SSH relay artifact cache lock heartbeat could not be persisted')
    }
    offset += bytesWritten
  }
  await handle.truncate(bytes.length)
  await handle.sync()
}

class SshRelayArtifactCacheLockLease {
  readonly lockPath: string
  readonly token: string
  private readonly contentId: SshRelayDigest
  private readonly directory: SshRelayArtifactCacheLockDirectoryIdentity
  private readonly ownerHandle: FileHandle
  private readonly owner: SshRelayArtifactCacheLockOwnerRecord
  private heartbeat: Promise<void> = Promise.resolve()
  private heartbeatError: unknown
  private heartbeatTimer: NodeJS.Timeout | undefined
  private released = false

  constructor(options: {
    lockPath: string
    contentId: SshRelayDigest
    token: string
    directory: SshRelayArtifactCacheLockDirectoryIdentity
    ownerHandle: FileHandle
    owner: SshRelayArtifactCacheLockOwnerRecord
  }) {
    this.lockPath = options.lockPath
    this.contentId = options.contentId
    this.token = options.token
    this.directory = options.directory
    this.ownerHandle = options.ownerHandle
    this.owner = options.owner
    this.heartbeatTimer = setInterval(
      () => this.queueHeartbeat(),
      SSH_RELAY_ARTIFACT_CACHE_HEARTBEAT_INTERVAL_MS
    )
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
        await writeCompleteRecord(this.ownerHandle, sshRelayArtifactCacheLockOwnerBytes(this.owner))
      } catch (error) {
        this.heartbeatError = error
      }
    })
  }

  private async ownsPath(): Promise<boolean> {
    const metadata = await lstat(this.lockPath, { bigint: true }).catch((error) => {
      if (sshRelayArtifactCacheErrorCode(error) === 'ENOENT') {
        return null
      }
      throw error
    })
    const current = await readSshRelayArtifactCacheLockOwner(this.lockPath, this.contentId)
    return Boolean(
      metadata?.isDirectory() &&
      sameSshRelayArtifactCacheLockDirectory(this.directory, metadata) &&
      current?.token === this.token
    )
  }

  private async assertPathOwnership(): Promise<void> {
    if (!(await this.ownsPath())) {
      throw new Error('SSH relay artifact cache lock ownership was displaced')
    }
  }

  async assertOwned(): Promise<void> {
    await this.heartbeat
    if (this.released || this.heartbeatError) {
      throw new Error('SSH relay artifact cache lock ownership is no longer active', {
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
      this.heartbeatTimer = undefined
    }
    await this.heartbeat
    let owned = false
    try {
      await this.assertPathOwnership()
      owned = true
    } catch {
      // A displaced owner must never remove the successor's lock.
    }
    if (!owned) {
      await this.ownerHandle.close()
      return
    }

    // Windows cannot rename a directory containing an open file; ownership is final-checked first.
    await this.ownerHandle.close()
    await releaseSshRelayArtifactCacheLockPath({
      lockPath: this.lockPath,
      token: this.token,
      checkOwnership: async () => ((await this.ownsPath()) ? 'owned' : 'displaced')
    })
  }
}

export type SshRelayArtifactCacheLock = Pick<
  SshRelayArtifactCacheLockLease,
  'lockPath' | 'token' | 'assertOwned' | 'release'
>

export function createSshRelayArtifactCacheLockLease(options: {
  lockPath: string
  contentId: SshRelayDigest
  token: string
  directory: SshRelayArtifactCacheLockDirectoryIdentity
  ownerHandle: FileHandle
  owner: SshRelayArtifactCacheLockOwnerRecord
}): SshRelayArtifactCacheLock {
  return new SshRelayArtifactCacheLockLease(options)
}
