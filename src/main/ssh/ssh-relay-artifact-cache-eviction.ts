import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  measureSshRelayArtifactCacheEntryLogicalBytes,
  SSH_RELAY_ARTIFACT_CACHE_MAXIMUM_MEMBERS_PER_ENTRY
} from './ssh-relay-artifact-cache-entry-accounting'
import { inspectSshRelayArtifactCacheInUse } from './ssh-relay-artifact-cache-in-use-inspection'
import { acquireSshRelayArtifactCacheLock } from './ssh-relay-artifact-cache-lock'
import { sshRelayArtifactCacheErrorCode } from './ssh-relay-artifact-cache-lock-record'
import {
  readSshRelayArtifactCacheRecency,
  removeSshRelayArtifactCacheRecency
} from './ssh-relay-artifact-cache-recency'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

const MAXIMUM_BYTES = 2 * 1024 * 1024 * 1024
const TRANSACTION_TIMEOUT_MS = 5 * 60_000
const CONTENT_HEX = /^[0-9a-f]{64}$/
const CONTENT_ID = /^sha256:[0-9a-f]{64}$/
const EVICTION_LOCK_ID = `sha256:${'0'.repeat(64)}` as SshRelayDigest

type CacheCandidate = {
  contentId: SshRelayDigest
  contentHex: string
  entryPath: string
  logicalBytes: number
  usedAtMs: number
  state: 'idle' | 'active' | 'ambiguous' | 'staging'
}

function exactMaximumBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('SSH relay artifact cache maximum bytes must be a non-negative safe integer')
  }
  return value
}

function exactContentSet(values: readonly SshRelayDigest[] | undefined): Set<SshRelayDigest> {
  const result = new Set<SshRelayDigest>()
  for (const value of values ?? []) {
    if (!CONTENT_ID.test(value)) {
      throw new Error('SSH relay artifact cache protected content ID must be an exact digest')
    }
    result.add(value)
  }
  return result
}

async function hasSameContentStaging(entries: string, contentHex: string): Promise<boolean> {
  const pattern = new RegExp(`^${contentHex}\\.pending-[0-9a-f]{32}$`)
  return (await readdir(entries)).some((name) => pattern.test(name))
}

async function inspectCandidate({
  cacheRoot,
  entries,
  contentHex,
  signal
}: {
  cacheRoot: string
  entries: string
  contentHex: string
  signal: AbortSignal
}): Promise<CacheCandidate | null> {
  const contentId = `sha256:${contentHex}` as SshRelayDigest
  const lock = await acquireSshRelayArtifactCacheLock({ cacheRoot, contentId, signal })
  try {
    signal.throwIfAborted()
    const entryPath = join(entries, contentHex)
    const root = await lstat(entryPath).catch((error) => {
      if (sshRelayArtifactCacheErrorCode(error) === 'ENOENT') {
        return null
      }
      throw error
    })
    if (!root) {
      return null
    }
    const logicalBytes = await measureSshRelayArtifactCacheEntryLogicalBytes(entryPath, signal)
    if (!root.isDirectory() || root.isSymbolicLink() || logicalBytes === null) {
      return {
        contentId,
        contentHex,
        entryPath,
        logicalBytes: 0,
        usedAtMs: Math.trunc(root.mtimeMs),
        state: 'ambiguous'
      }
    }
    const recency = await readSshRelayArtifactCacheRecency({
      cacheRoot,
      contentId,
      initialUsedAtMs: root.mtimeMs
    })
    const inUse = await inspectSshRelayArtifactCacheInUse({ cacheRoot, contentId, signal })
    const staging = await hasSameContentStaging(entries, contentHex)
    return {
      contentId,
      contentHex,
      entryPath,
      logicalBytes,
      usedAtMs: recency.kind === 'known' ? recency.usedAtMs : Math.trunc(root.mtimeMs),
      state: staging ? 'staging' : recency.kind === 'ambiguous' ? 'ambiguous' : inUse
    }
  } finally {
    await lock.release()
  }
}

function candidateOrder(
  preferred: ReadonlySet<SshRelayDigest>
): (left: CacheCandidate, right: CacheCandidate) => number {
  return (left, right) => {
    const preference =
      Number(preferred.has(left.contentId)) - Number(preferred.has(right.contentId))
    return (
      preference ||
      left.usedAtMs - right.usedAtMs ||
      left.contentHex.localeCompare(right.contentHex)
    )
  }
}

async function deleteIdleCandidate({
  cacheRoot,
  entries,
  candidate,
  signal
}: {
  cacheRoot: string
  entries: string
  candidate: CacheCandidate
  signal: AbortSignal
}): Promise<number | null> {
  const lock = await acquireSshRelayArtifactCacheLock({
    cacheRoot,
    contentId: candidate.contentId,
    signal
  })
  try {
    signal.throwIfAborted()
    if (await hasSameContentStaging(entries, candidate.contentHex)) {
      return null
    }
    const root = await lstat(candidate.entryPath).catch(() => null)
    if (!root?.isDirectory() || root.isSymbolicLink()) {
      return null
    }
    const recency = await readSshRelayArtifactCacheRecency({
      cacheRoot,
      contentId: candidate.contentId,
      initialUsedAtMs: root.mtimeMs
    })
    // Why: a use that races the initial LRU scan wins; a later transaction can reconsider it.
    if (recency.kind !== 'known' || recency.usedAtMs !== candidate.usedAtMs) {
      return null
    }
    const inUse = await inspectSshRelayArtifactCacheInUse({
      cacheRoot,
      contentId: candidate.contentId,
      signal
    })
    if (inUse !== 'idle') {
      return null
    }
    const bytes = await measureSshRelayArtifactCacheEntryLogicalBytes(candidate.entryPath, signal)
    if (bytes === null) {
      return null
    }
    const tombstone = `${candidate.entryPath}.evicting-${randomBytes(16).toString('hex')}`
    // Why: only an exact final entry is renamed unselectable before owned recursive deletion.
    await rename(candidate.entryPath, tombstone)
    await rm(tombstone, { recursive: true, force: true })
    await Promise.all([
      removeSshRelayArtifactCacheRecency(cacheRoot, candidate.contentId).catch(() => {}),
      rm(resolve(cacheRoot, 'in-use', candidate.contentHex), {
        recursive: true,
        force: true
      }).catch(() => {})
    ])
    return bytes
  } catch (error) {
    if (sshRelayArtifactCacheErrorCode(error) === 'ENOENT') {
      return null
    }
    throw error
  } finally {
    await lock.release()
  }
}

export type SshRelayArtifactCacheEvictionResult = {
  initialBytes: number
  finalBytes: number
  reclaimedBytes: number
  evictedContentIds: SshRelayDigest[]
  blockedContentIds: SshRelayDigest[]
  accountingComplete: boolean
}

export async function evictSshRelayArtifactCache({
  cacheRoot,
  maximumBytes = MAXIMUM_BYTES,
  protectedContentIds,
  preferredRetentionContentIds,
  signal
}: {
  cacheRoot: string
  maximumBytes?: number
  protectedContentIds?: readonly SshRelayDigest[]
  preferredRetentionContentIds?: readonly SshRelayDigest[]
  signal?: AbortSignal
}): Promise<SshRelayArtifactCacheEvictionResult> {
  const limit = exactMaximumBytes(maximumBytes)
  const protectedSet = exactContentSet(protectedContentIds)
  const preferredSet = exactContentSet(preferredRetentionContentIds)
  const timeout = AbortSignal.timeout(TRANSACTION_TIMEOUT_MS)
  const activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  activeSignal.throwIfAborted()
  const root = resolve(cacheRoot)
  const entries = join(root, 'entries')
  await mkdir(entries, { recursive: true, mode: 0o700 })
  // Why: the dedicated namespace serializes LRU transactions without reserving a content digest.
  const transaction = await acquireSshRelayArtifactCacheLock({
    cacheRoot: join(root, 'eviction-transaction'),
    contentId: EVICTION_LOCK_ID,
    signal: activeSignal
  })
  try {
    const candidates: CacheCandidate[] = []
    for (const name of (await readdir(entries)).sort()) {
      activeSignal.throwIfAborted()
      if (!CONTENT_HEX.test(name)) {
        continue
      }
      const candidate = await inspectCandidate({
        cacheRoot: root,
        entries,
        contentHex: name,
        signal: activeSignal
      })
      if (candidate) {
        candidates.push(candidate)
      }
    }
    const accountingComplete = candidates.every((candidate) => candidate.logicalBytes > 0)
    const initialBytes = candidates.reduce((total, candidate) => total + candidate.logicalBytes, 0)
    let finalBytes = initialBytes
    const blocked = candidates
      .filter((candidate) => candidate.state !== 'idle' || protectedSet.has(candidate.contentId))
      .map((candidate) => candidate.contentId)
    const evictable = candidates
      .filter((candidate) => candidate.state === 'idle' && !protectedSet.has(candidate.contentId))
      .sort(candidateOrder(preferredSet))
    const evictedContentIds: SshRelayDigest[] = []
    for (const candidate of evictable) {
      if (finalBytes <= limit) {
        break
      }
      activeSignal.throwIfAborted()
      const reclaimed = await deleteIdleCandidate({
        cacheRoot: root,
        entries,
        candidate,
        signal: activeSignal
      })
      if (reclaimed === null) {
        blocked.push(candidate.contentId)
        continue
      }
      finalBytes -= reclaimed
      evictedContentIds.push(candidate.contentId)
    }
    return {
      initialBytes,
      finalBytes,
      reclaimedBytes: initialBytes - finalBytes,
      evictedContentIds,
      blockedContentIds: [...new Set(blocked)],
      accountingComplete
    }
  } finally {
    await transaction.release()
  }
}

export const SSH_RELAY_ARTIFACT_CACHE_EVICTION_LIMITS = Object.freeze({
  maximumBytes: MAXIMUM_BYTES,
  transactionTimeoutMs: TRANSACTION_TIMEOUT_MS,
  maximumMembersPerEntry: SSH_RELAY_ARTIFACT_CACHE_MAXIMUM_MEMBERS_PER_ENTRY
})
