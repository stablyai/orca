import { gitExecFileAsync } from '../git/runner'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'

type LocalGitExecOptions = { wslDistro?: string }

export type BranchHeadRemoteQuery = {
  repoPath: string
  branchName: string
  connectionId?: string | null
  localGitOptions?: LocalGitExecOptions
}

const REMOTE_REF_PREFIX = 'refs/remotes/'

// Why: resolution runs only when a branch lookup misses, but a branch with no
// pull request misses on every poll. Cache so the git call is once per branch
// per window rather than once per poll; short enough that a first push to a
// new remote is picked up quickly.
const HEAD_REMOTE_CACHE_TTL_MS = 30_000
const HEAD_REMOTE_CACHE_MAX_ENTRIES = 512
const headRemoteCache = new Map<string, { value: string | null; expiresAt: number }>()
// Why: several surfaces can miss the same branch in the same tick. Without
// this, each spawns its own git process for an answer they all share.
const headRemoteInFlight = new Map<string, Promise<string | null>>()

function headRemoteCacheKey(query: BranchHeadRemoteQuery): string {
  const runtime = query.connectionId
    ? `ssh:${query.connectionId}`
    : `local:${query.localGitOptions?.wslDistro ?? 'host'}`
  return [runtime, query.repoPath, query.branchName].join('\0')
}

/** @internal - exposed for tests only */
export function _resetBranchHeadRemoteCache(): void {
  headRemoteCache.clear()
  headRemoteInFlight.clear()
}

function readCachedHeadRemote(key: string, now: number): { value: string | null } | null {
  const entry = headRemoteCache.get(key)
  return entry && entry.expiresAt > now ? { value: entry.value } : null
}

function storeHeadRemote(key: string, value: string | null, now: number): void {
  headRemoteCache.delete(key)
  headRemoteCache.set(key, { value, expiresAt: now + HEAD_REMOTE_CACHE_TTL_MS })
  for (const [candidate, entry] of headRemoteCache) {
    if (entry.expiresAt <= now) {
      headRemoteCache.delete(candidate)
    }
  }
  while (headRemoteCache.size > HEAD_REMOTE_CACHE_MAX_ENTRIES) {
    const oldest = headRemoteCache.keys().next().value
    if (oldest === undefined) {
      return
    }
    headRemoteCache.delete(oldest)
  }
}

async function readGitStdout(
  args: readonly string[],
  query: BranchHeadRemoteQuery
): Promise<string | null> {
  try {
    if (query.connectionId) {
      // Why: repoPath addresses the remote host's filesystem. Falling back to
      // local git here would run against whatever happens to sit at the same
      // path on this machine, which can name a remote from an unrelated repo.
      const provider = getSshGitProvider(query.connectionId)
      return provider ? (await provider.exec([...args], query.repoPath)).stdout : null
    }
    const wslDistro = query.localGitOptions?.wslDistro
    const result = await gitExecFileAsync([...args], {
      cwd: query.repoPath,
      ...(wslDistro ? { wslDistro } : {})
    })
    return result.stdout
  } catch {
    // Why: a missing config key exits non-zero, and an unreachable SSH host
    // throws. Both mean "cannot tell", which the caller degrades safely.
    return null
  }
}

/**
 * Remote names holding a tracking ref for this branch, newest listing order.
 *
 * The branch name is matched as an exact suffix rather than by splitting on
 * `/`, so a branch containing slashes (`user/feature`) cannot be mistaken for
 * a remote segment, and the remainder is the remote name verbatim.
 */
function parseRemoteNamesForBranch(stdout: string, branchName: string): string[] {
  const suffix = `/${branchName}`
  const names: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const ref = line.trim()
    if (!ref.startsWith(REMOTE_REF_PREFIX) || !ref.endsWith(suffix)) {
      continue
    }
    const name = ref.slice(REMOTE_REF_PREFIX.length, ref.length - suffix.length)
    if (name && !names.includes(name)) {
      names.push(name)
    }
  }
  return names
}

async function readConfiguredPushRemote(query: BranchHeadRemoteQuery): Promise<string | null> {
  // Ordered by how specifically each key names this branch's push target.
  const keys = [
    `branch.${query.branchName}.pushRemote`,
    'remote.pushDefault',
    `branch.${query.branchName}.remote`
  ]
  for (const key of keys) {
    const value = (await readGitStdout(['config', '--get', key], query))?.trim()
    if (value) {
      return value
    }
  }
  return null
}

/**
 * The remote that actually holds this branch's head, or null when it cannot be
 * determined locally.
 *
 * Why: a cross-fork pull request's head is owned by the fork the branch was
 * pushed to, which is not necessarily `origin` (#12956). Callers that assume
 * `origin` build a `head=<owner>:<branch>` filter for the wrong owner, which
 * GitHub answers with an empty list rather than an error — a silent "no pull
 * request" for a branch that has one.
 *
 * Resolution prefers the existing remote-tracking ref because it is one local
 * git call and is present whenever the branch was pushed, including the common
 * `git push <remote> <branch>` case that sets no upstream configuration at all.
 * Configuration is consulted only when the refs are absent or ambiguous.
 *
 * Returning null is deliberate and safe: the branch-lookup caller falls back to
 * a head-owner-agnostic `gh pr list --head` query, which resolves cross-fork
 * heads on its own.
 */
export async function resolveBranchHeadRemoteName(
  query: BranchHeadRemoteQuery
): Promise<string | null> {
  if (!query.branchName || query.branchName === 'HEAD') {
    return null
  }
  const cacheKey = headRemoteCacheKey(query)
  const cached = readCachedHeadRemote(cacheKey, Date.now())
  if (cached) {
    return cached.value
  }
  const pending = headRemoteInFlight.get(cacheKey)
  if (pending) {
    return pending
  }
  const probe = (async () => {
    const resolved = await resolveUncachedBranchHeadRemoteName(query)
    storeHeadRemote(cacheKey, resolved, Date.now())
    return resolved
  })()
  headRemoteInFlight.set(cacheKey, probe)
  try {
    return await probe
  } finally {
    if (headRemoteInFlight.get(cacheKey) === probe) {
      headRemoteInFlight.delete(cacheKey)
    }
  }
}

async function resolveUncachedBranchHeadRemoteName(
  query: BranchHeadRemoteQuery
): Promise<string | null> {
  const refsStdout = await readGitStdout(
    ['for-each-ref', '--format=%(refname)', `${REMOTE_REF_PREFIX}*/${query.branchName}`],
    query
  )
  const remoteNames = refsStdout ? parseRemoteNamesForBranch(refsStdout, query.branchName) : []
  if (remoteNames.length === 1) {
    return remoteNames[0] ?? null
  }
  const configured = await readConfiguredPushRemote(query)
  if (configured && (remoteNames.length === 0 || remoteNames.includes(configured))) {
    return configured
  }
  // Why: several forks carry this branch and nothing names a push target, so
  // any pick would be a guess. Let the head-agnostic list query decide.
  return null
}

/**
 * The repository whose fork holds this branch, resolved through the caller's
 * remote-to-repository lookup.
 *
 * The lookup is injected rather than imported so this module stays free of a
 * dependency on the GitHub repository resolver that consumes it.
 */
export async function resolveBranchHeadRepository<TRepository>(
  query: BranchHeadRemoteQuery,
  getRepositoryForRemote: (remoteName: string) => Promise<TRepository | null>
): Promise<TRepository | null> {
  const remoteName = await resolveBranchHeadRemoteName(query)
  return remoteName ? getRepositoryForRemote(remoteName) : null
}
