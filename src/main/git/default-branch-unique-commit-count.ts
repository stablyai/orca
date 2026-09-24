import { resolveDefaultBaseRefViaExec, type GitExec } from './repo-default-base-ref'

const UNIQUE_COMMIT_CACHE_TTL_MS = 30_000
const UNIQUE_COMMIT_CACHE_MAX_ENTRIES = 2_048
const PROBE_BUDGET_MS = 2_000
const PROBE_CONCURRENCY = 6

type CacheEntry = { count: number | null; expiresAt: number }

const uniqueCommitCountCache = new Map<string, CacheEntry>()
const probeCursorByRepo = new Map<string, number>()

function rememberCount(key: string, count: number | null): void {
  const now = Date.now()
  for (const [cachedKey, entry] of uniqueCommitCountCache) {
    if (entry.expiresAt <= now) {
      uniqueCommitCountCache.delete(cachedKey)
    }
  }
  uniqueCommitCountCache.set(key, { count, expiresAt: now + UNIQUE_COMMIT_CACHE_TTL_MS })
  while (uniqueCommitCountCache.size > UNIQUE_COMMIT_CACHE_MAX_ENTRIES) {
    const oldest = uniqueCommitCountCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    uniqueCommitCountCache.delete(oldest)
  }
}

function cachedCount(key: string): number | null | undefined {
  const entry = uniqueCommitCountCache.get(key)
  if (!entry) {
    return undefined
  }
  if (entry.expiresAt <= Date.now()) {
    uniqueCommitCountCache.delete(key)
    return undefined
  }
  return entry.count
}

/** A ref we resolved ourselves. Reject anything git could treat as a flag or a second range. */
function isSafeRevision(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith('-') && !ref.includes('..') && /^[\w./-]+$/.test(ref)
}

function isCommitOid(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value)
}

/**
 * Commits on `head` that are not on `defaultRef`.
 * `null` means the host did not verify the comparison — callers must not treat that as contained.
 */
export async function countCommitsNotOnRef(
  exec: GitExec,
  defaultRef: string,
  head: string
): Promise<number | null> {
  if (!isSafeRevision(defaultRef) || !isCommitOid(head)) {
    return null
  }
  try {
    const { stdout } = await exec(['rev-list', '--count', `${defaultRef}..${head}`])
    const count = Number(stdout.trim())
    return Number.isInteger(count) && count >= 0 ? count : null
  } catch {
    return null
  }
}

export type WorktreeHeadProbe = { id: string; head: string }

/**
 * Unique commits against the repo's default branch for each head.
 * A missing entry means unverified. Loss of contact and a failed probe stay unverified.
 */
export async function countUniqueCommitsAgainstDefaultBranch(args: {
  repoKey: string
  exec: GitExec | null
  heads: readonly WorktreeHeadProbe[]
}): Promise<Map<string, number>> {
  const verified = new Map<string, number>()
  if (!args.exec || args.heads.length === 0) {
    return verified
  }
  const exec = args.exec
  const defaultRef = await resolveDefaultBaseRefViaExec(exec).catch(() => null)
  if (!defaultRef || !isSafeRevision(defaultRef)) {
    return verified
  }
  const pending: WorktreeHeadProbe[] = []
  for (const head of args.heads) {
    if (!isCommitOid(head.head)) {
      continue
    }
    const cacheKey = `${args.repoKey}\0${defaultRef}\0${head.head.toLowerCase()}`
    const cached = cachedCount(cacheKey)
    if (cached === undefined) {
      pending.push(head)
      continue
    }
    if (cached !== null) {
      verified.set(head.id, cached)
    }
  }
  if (pending.length === 0) {
    return verified
  }
  const cursor = probeCursorByRepo.get(args.repoKey) ?? 0
  const start = cursor % pending.length
  const ordered = pending.slice(start).concat(pending.slice(0, start))
  const deadline = Date.now() + PROBE_BUDGET_MS
  let probed = 0
  let nextIndex = 0
  const workerCount = Math.min(PROBE_CONCURRENCY, ordered.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < ordered.length && Date.now() < deadline) {
        const head = ordered[nextIndex]
        nextIndex += 1
        probed += 1
        const cacheKey = `${args.repoKey}\0${defaultRef}\0${head.head.toLowerCase()}`
        const count = await countCommitsNotOnRef(exec, defaultRef, head.head)
        rememberCount(cacheKey, count)
        if (count !== null) {
          verified.set(head.id, count)
        }
      }
    })
  )
  if (probed > 0) {
    probeCursorByRepo.set(args.repoKey, (cursor + probed) % pending.length)
  }
  return verified
}

export function resetDefaultBranchUniqueCommitCacheForTests(): void {
  uniqueCommitCountCache.clear()
  probeCursorByRepo.clear()
}
