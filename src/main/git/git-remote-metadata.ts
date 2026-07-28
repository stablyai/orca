import { gitExecFileAsync } from './runner'
import { readLocalGitConfigSignature } from '../github/local-git-config-signature'

// Cache for near-static `git remote …` reads on host-local repos. A repo's
// remotes change ~never during a session, yet per-worktree PR/identity polling
// re-spawned `git remote` / `git remote -v` on every tick (#7576: `git remote`
// alone hit 242 spawns / 6 min on a 9-worktree profile). The cache is
// invalidated by the `.git/config` signature — remotes live in that file, so an
// mtime/size change is the exact right miss trigger (the GitHub owner/repo cache
// already uses this) — with a TTL backstop for hosts where the signature is
// unavailable. Errors are never cached: callers degrade on their own (count→0,
// identity→null), so a transient git failure must re-run next time.

const CACHE_TTL_MS = 10 * 60_000
const CACHE_MAX_ENTRIES = 1024

type RemoteReadOp = 'names' | 'verbose'

type RemoteReadCacheEntry = {
  value: string
  expiresAt: number
  configSignature?: string
}

const cache = new Map<string, RemoteReadCacheEntry>()
const inFlight = new Map<string, Promise<string>>()
const cacheWriteTokens = new Map<string, symbol>()

function cacheKey(repoPath: string, op: RemoteReadOp): string {
  return `${repoPath}\0${op}`
}

function prune(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key)
    }
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    cache.delete(oldestKey)
  }
}

async function cachedRemoteRead(
  repoPath: string,
  op: RemoteReadOp,
  args: string[]
): Promise<string> {
  const key = cacheKey(repoPath, op)
  const now = Date.now()
  const entry = cache.get(key)
  if (entry && entry.expiresAt > now) {
    if (entry.configSignature === undefined) {
      return entry.value
    }
    // Cheap re-stat vs a subprocess spawn: hold the value until `.git/config` moves.
    const currentSignature = await readLocalGitConfigSignature({ repoPath })
    if (currentSignature === entry.configSignature) {
      return entry.value
    }
    cache.delete(key)
  } else if (entry) {
    cache.delete(key)
  }

  const existing = inFlight.get(key)
  if (existing) {
    return existing
  }

  // Why: register the probe synchronously — reading the signature is itself
  // async, so a concurrent caller must find this in-flight entry rather than
  // race past an `await` and spawn a duplicate.
  const cacheWriteToken = Symbol(key)
  cacheWriteTokens.set(key, cacheWriteToken)
  const probe = (async () => {
    const configSignature = await readLocalGitConfigSignature({ repoPath })
    const { stdout } = await gitExecFileAsync(args, { cwd: repoPath })
    if (cacheWriteTokens.get(key) === cacheWriteToken) {
      cache.set(key, {
        value: stdout,
        expiresAt: Date.now() + CACHE_TTL_MS,
        ...(configSignature !== undefined ? { configSignature } : {})
      })
      prune(Date.now())
    }
    return stdout
  })()
  inFlight.set(key, probe)
  try {
    return await probe
  } finally {
    if (inFlight.get(key) === probe) {
      inFlight.delete(key)
    }
    if (cacheWriteTokens.get(key) === cacheWriteToken) {
      cacheWriteTokens.delete(key)
    }
  }
}

/** Raw stdout of `git remote` (one remote name per line) for a host-local repo. */
export function getRemoteListRaw(repoPath: string): Promise<string> {
  return cachedRemoteRead(repoPath, 'names', ['remote'])
}

/** Raw stdout of `git remote -v` for a host-local repo. */
export function getRemoteVerboseRaw(repoPath: string): Promise<string> {
  return cachedRemoteRead(repoPath, 'verbose', ['remote', '-v'])
}

/** Drop cached remote reads for a repo (e.g. after a known remote mutation). */
export function invalidateGitRemoteMetadata(repoPath: string): void {
  for (const op of ['names', 'verbose'] as const) {
    const key = cacheKey(repoPath, op)
    cache.delete(key)
    inFlight.delete(key)
    cacheWriteTokens.delete(key)
  }
}

export function __resetGitRemoteMetadataCacheForTests(): void {
  cache.clear()
  inFlight.clear()
  cacheWriteTokens.clear()
}
