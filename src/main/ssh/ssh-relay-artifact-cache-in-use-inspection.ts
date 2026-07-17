import { randomBytes } from 'node:crypto'
import { lstat, readdir, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'

import {
  readSshRelayArtifactCacheInUseOwner,
  sameSshRelayArtifactCacheInUseDirectory
} from './ssh-relay-artifact-cache-in-use-record'
import { sshRelayArtifactCacheErrorCode } from './ssh-relay-artifact-cache-lock-record'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

export const SSH_RELAY_ARTIFACT_CACHE_IN_USE_STALE_AFTER_MS = 30_000
const CONTENT_ID = /^sha256:([0-9a-f]{64})$/
const LEASE_NAME = /^([0-9a-f]{32})\.lease$/

function exactContentHex(contentId: SshRelayDigest): string {
  const match = CONTENT_ID.exec(contentId)
  if (!match) {
    throw new Error('SSH relay artifact cache in-use content ID must be an exact lowercase digest')
  }
  return match[1]
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return sshRelayArtifactCacheErrorCode(error) !== 'ESRCH'
  }
}

export async function inspectSshRelayArtifactCacheInUse({
  cacheRoot,
  contentId,
  signal
}: {
  cacheRoot: string
  contentId: SshRelayDigest
  signal: AbortSignal
}): Promise<'idle' | 'active' | 'ambiguous'> {
  const parent = resolve(cacheRoot, 'in-use', exactContentHex(contentId))
  let names: string[]
  try {
    names = await readdir(parent)
  } catch (error) {
    return sshRelayArtifactCacheErrorCode(error) === 'ENOENT' ? 'idle' : 'ambiguous'
  }
  for (const name of names) {
    signal.throwIfAborted()
    const match = LEASE_NAME.exec(name)
    if (!match) {
      return 'ambiguous'
    }
    const token = match[1]
    const leasePath = join(parent, name)
    const directory = await lstat(leasePath, { bigint: true }).catch(() => null)
    const owner = await readSshRelayArtifactCacheInUseOwner(leasePath, contentId, token)
    if (!directory?.isDirectory() || directory.isSymbolicLink() || !owner) {
      return 'ambiguous'
    }
    if (Date.now() - owner.heartbeatAtMs < SSH_RELAY_ARTIFACT_CACHE_IN_USE_STALE_AFTER_MS) {
      return 'active'
    }
    if (owner.hostname !== hostname()) {
      return 'ambiguous'
    }
    if (localProcessIsAlive(owner.pid)) {
      return 'active'
    }
    const confirmed = await readSshRelayArtifactCacheInUseOwner(leasePath, contentId, token)
    const current = await lstat(leasePath, { bigint: true }).catch(() => null)
    if (
      !confirmed ||
      confirmed.heartbeatAtMs !== owner.heartbeatAtMs ||
      !current ||
      !sameSshRelayArtifactCacheInUseDirectory(directory, current)
    ) {
      return 'ambiguous'
    }
    const tombstone = `${leasePath}.stale-${randomBytes(16).toString('hex')}`
    await rename(leasePath, tombstone)
    await rm(tombstone, { recursive: true, force: true })
  }
  return 'idle'
}
