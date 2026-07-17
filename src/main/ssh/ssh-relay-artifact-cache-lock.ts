import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import {
  createSshRelayArtifactCacheLockLease,
  SSH_RELAY_ARTIFACT_CACHE_HEARTBEAT_INTERVAL_MS,
  type SshRelayArtifactCacheLock
} from './ssh-relay-artifact-cache-lock-lease'
import {
  readSshRelayArtifactCacheLockOwner,
  sshRelayArtifactCacheErrorCode,
  sshRelayArtifactCacheLockOwnerBytes,
  SSH_RELAY_ARTIFACT_CACHE_LOCK_SCHEMA_VERSION,
  type SshRelayArtifactCacheLockOwnerRecord
} from './ssh-relay-artifact-cache-lock-record'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

const STALE_AFTER_MS = 30_000
const WAIT_TIMEOUT_MS = 2 * 60_000
const WAIT_POLL_MS = 100
const CONTENT_ID = /^sha256:([0-9a-f]{64})$/

function exactContentHex(contentId: SshRelayDigest): string {
  const match = CONTENT_ID.exec(contentId)
  if (!match) {
    throw new Error('SSH relay artifact cache content ID must be an exact lowercase SHA-256 digest')
  }
  return match[1]
}

export function sshRelayArtifactCacheLockPath(
  cacheRoot: string,
  contentId: SshRelayDigest
): string {
  return resolve(cacheRoot, 'locks', `${exactContentHex(contentId)}.lock`)
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return sshRelayArtifactCacheErrorCode(error) !== 'ESRCH'
  }
}

async function waitForRetry(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolveWait, rejectWait) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolveWait()
    }, WAIT_POLL_MS)
    const abort = (): void => {
      clearTimeout(timer)
      rejectWait(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function createPendingOwner(
  lockPath: string,
  contentId: SshRelayDigest,
  token: string
): Promise<{ pendingPath: string; owner: SshRelayArtifactCacheLockOwnerRecord }> {
  const now = Date.now()
  const owner: SshRelayArtifactCacheLockOwnerRecord = {
    schemaVersion: SSH_RELAY_ARTIFACT_CACHE_LOCK_SCHEMA_VERSION,
    contentId,
    token,
    hostname: hostname(),
    pid: process.pid,
    acquiredAtMs: now,
    heartbeatAtMs: now
  }
  const pendingPath = `${lockPath}.pending-${token}`
  await mkdir(pendingPath, { mode: 0o700 })
  try {
    const handle = await open(join(pendingPath, 'owner.json'), 'wx', 0o600)
    try {
      await handle.writeFile(sshRelayArtifactCacheLockOwnerBytes(owner))
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { pendingPath, owner }
  } catch (error) {
    await rm(pendingPath, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function tryCreateLock(
  lockPath: string,
  contentId: SshRelayDigest,
  token: string
): Promise<SshRelayArtifactCacheLockOwnerRecord | null> {
  const { pendingPath, owner } = await createPendingOwner(lockPath, contentId, token)
  try {
    await rename(pendingPath, lockPath)
    return owner
  } catch (error) {
    await rm(pendingPath, { recursive: true, force: true }).catch(() => {})
    if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(sshRelayArtifactCacheErrorCode(error) ?? '')) {
      return null
    }
    throw error
  }
}

async function tryReclaimDeadOwner(lockPath: string, contentId: SshRelayDigest): Promise<boolean> {
  const observed = await readSshRelayArtifactCacheLockOwner(lockPath, contentId)
  if (
    !observed ||
    Date.now() - observed.heartbeatAtMs < STALE_AFTER_MS ||
    observed.hostname !== hostname() ||
    localProcessIsAlive(observed.pid)
  ) {
    return false
  }
  const confirmed = await readSshRelayArtifactCacheLockOwner(lockPath, contentId)
  if (
    !confirmed ||
    confirmed.token !== observed.token ||
    confirmed.heartbeatAtMs !== observed.heartbeatAtMs
  ) {
    return false
  }
  const tombstone = `${lockPath}.stale-${randomBytes(16).toString('hex')}`
  try {
    // Why: a stale lock becomes unselectable before cleanup; no reclaimer deletes through a live path.
    await rename(lockPath, tombstone)
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(sshRelayArtifactCacheErrorCode(error) ?? '')) {
      return false
    }
    throw error
  }
  await rm(tombstone, { recursive: true, force: true })
  return true
}

export async function acquireSshRelayArtifactCacheLock({
  cacheRoot,
  contentId,
  signal
}: {
  cacheRoot: string
  contentId: SshRelayDigest
  signal?: AbortSignal
}): Promise<SshRelayArtifactCacheLock> {
  const timeout = AbortSignal.timeout(WAIT_TIMEOUT_MS)
  const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  effectiveSignal.throwIfAborted()
  const logicalPath = sshRelayArtifactCacheLockPath(cacheRoot, contentId)
  await mkdir(dirname(logicalPath), { recursive: true, mode: 0o700 })
  const lockParent = await realpath(dirname(logicalPath))
  const lockPath = join(lockParent, basename(logicalPath))

  while (true) {
    effectiveSignal.throwIfAborted()
    const token = randomBytes(16).toString('hex')
    const owner = await tryCreateLock(lockPath, contentId, token)
    if (owner) {
      const directory = await lstat(lockPath, { bigint: true })
      const ownerHandle = await open(join(lockPath, 'owner.json'), 'r+')
      return createSshRelayArtifactCacheLockLease({
        lockPath,
        contentId,
        token,
        directory,
        ownerHandle,
        owner
      })
    }
    if (await tryReclaimDeadOwner(lockPath, contentId)) {
      continue
    }
    await waitForRetry(effectiveSignal)
  }
}

export const SSH_RELAY_ARTIFACT_CACHE_LOCK_LIMITS = Object.freeze({
  heartbeatIntervalMs: SSH_RELAY_ARTIFACT_CACHE_HEARTBEAT_INTERVAL_MS,
  staleAfterMs: STALE_AFTER_MS,
  waitTimeoutMs: WAIT_TIMEOUT_MS,
  waitPollMs: WAIT_POLL_MS
})
