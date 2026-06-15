import { execFile } from 'child_process'
import { promisify } from 'util'
import { gitExecFileAsync, ghExecFileAsync, extractExecError } from '../git/runner'
import type { IssueSourcePreference } from '../../shared/types'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  normalizeGitHubApiHost,
  parseGitHubOwnerRepo,
  parseGitHubRemoteIdentity,
  preferredGitHubApiHost
} from './remote-identity'
import type { GitHubRemoteIdentity, OwnerRepo } from './remote-identity'

// Why: keep gh-utils the stable import surface for callers that historically
// imported these primitives from here.
export {
  normalizeGitHubApiHost,
  parseGitHubOwnerRepo,
  parseGitHubRemoteIdentity,
  preferredGitHubApiHost
}
export type { GitHubRemoteIdentity, OwnerRepo }
export { classifyGhError, classifyListIssuesError } from './gh-error-classification'

// Why: legacy generic execFile wrapper — only used by callers that don't need
// WSL-aware routing (e.g. non-repo-scoped gh commands). Repo-scoped callers
// should use ghExecFileAsync or gitExecFileAsync from the runner instead.
export const execFileAsync = promisify(execFile)
export { ghExecFileAsync, gitExecFileAsync, extractExecError }

// Concurrency limiter - max 4 parallel gh processes
const MAX_CONCURRENT = 4
let running = 0
const queue: (() => void)[] = []

export function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running++
      resolve()
    })
  )
}

export function release(): void {
  running--
  const next = queue.shift()
  if (next) {
    next()
  }
}

// ── Owner/repo resolution for gh api --cache ──────────────────────────
export type GitHubRepoContext = {
  repoPath: string
  connectionId?: string | null
}

export function githubRepoContext(
  repoPath: string,
  connectionId?: string | null
): GitHubRepoContext {
  return { repoPath, connectionId: connectionId ?? null }
}

export function ghRepoExecOptions(context: GitHubRepoContext): {
  cwd?: string
  encoding?: BufferEncoding
} {
  // Why: SSH repo paths are meaningful only on the remote host. All GitHub
  // calls in this layer pass explicit --repo/API targets, so local gh should
  // not receive a remote-only cwd.
  return context.connectionId ? {} : { cwd: context.repoPath }
}

const OWNER_REPO_CACHE_TTL_MS = 30_000
const OWNER_REPO_CACHE_MAX_ENTRIES = 512

type OwnerRepoCacheEntry = {
  value: OwnerRepo | null
  expiresAt: number
}

const ownerRepoCache = new Map<string, OwnerRepoCacheEntry>()
const ownerRepoInFlight = new Map<string, Promise<OwnerRepo | null>>()
const repoHostCache = new Map<string, { value: string | null; expiresAt: number }>()

/** @internal — exposed for tests only */
export function _resetOwnerRepoCache(): void {
  ownerRepoCache.clear()
  ownerRepoInFlight.clear()
  repoHostCache.clear()
}

/** @internal — exposed for tests only */
export function _getOwnerRepoCacheSize(): number {
  return ownerRepoCache.size
}

function pruneOwnerRepoCache(now: number): void {
  for (const [key, entry] of ownerRepoCache) {
    if (entry.expiresAt <= now) {
      ownerRepoCache.delete(key)
    }
  }
  while (ownerRepoCache.size > OWNER_REPO_CACHE_MAX_ENTRIES) {
    const oldestKey = ownerRepoCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    ownerRepoCache.delete(oldestKey)
  }
}

export async function getGitHubApiHostForRepo(
  repoPath: string,
  connectionId?: string | null
): Promise<string | null> {
  const context = githubRepoContext(repoPath, connectionId)
  const cacheKey = `${context.connectionId ?? 'local'}\0${context.repoPath}\0api-host`
  const cached = repoHostCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }
  if (cached) {
    repoHostCache.delete(cacheKey)
  }

  let fallback: string | null = null
  for (const remoteName of ['upstream', 'origin']) {
    try {
      const remoteUrl = await getRemoteUrlForRepo(context, remoteName)
      const identity = remoteUrl ? parseGitHubRemoteIdentity(remoteUrl) : null
      const host = identity ? normalizeGitHubApiHost(identity.host) : null
      if (!host) {
        continue
      }
      if (preferredGitHubApiHost(host)) {
        repoHostCache.set(cacheKey, {
          value: host,
          expiresAt: Date.now() + OWNER_REPO_CACHE_TTL_MS
        })
        return host
      }
      fallback ??= host
    } catch {
      // ignore missing remotes or non-git paths
    }
  }

  repoHostCache.set(cacheKey, { value: fallback, expiresAt: Date.now() + OWNER_REPO_CACHE_TTL_MS })
  return fallback
}

export async function getRemoteUrlForRepo(
  context: GitHubRepoContext,
  remoteName: string
): Promise<string | null> {
  if (context.connectionId) {
    const provider = getSshGitProvider(context.connectionId)
    if (!provider) {
      return null
    }
    const { stdout } = await provider.exec(['remote', 'get-url', remoteName], context.repoPath)
    return stdout
  }
  const { stdout } = await gitExecFileAsync(['remote', 'get-url', remoteName], {
    cwd: context.repoPath
  })
  return stdout
}

export async function getOwnerRepoForRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null
): Promise<OwnerRepo | null> {
  const context = githubRepoContext(repoPath, connectionId)
  const cacheKey = `${context.connectionId ?? 'local'}\0${context.repoPath}\0${remoteName}`
  const now = Date.now()
  pruneOwnerRepoCache(now)
  const cached = ownerRepoCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const inFlight = ownerRepoInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  // Why: startup can resolve issue sources, PR candidates, and repo metadata
  // for the same repo concurrently. Coalesce missing-remote probes so a stable
  // absent upstream does not spawn identical `git remote get-url` processes.
  const probe = resolveOwnerRepoForRemote(context, remoteName, cacheKey)
  ownerRepoInFlight.set(cacheKey, probe)
  try {
    return await probe
  } finally {
    if (ownerRepoInFlight.get(cacheKey) === probe) {
      ownerRepoInFlight.delete(cacheKey)
    }
  }
}

async function resolveOwnerRepoForRemote(
  context: GitHubRepoContext,
  remoteName: string,
  cacheKey: string
): Promise<OwnerRepo | null> {
  const now = Date.now()
  try {
    const remoteUrl = await getRemoteUrlForRepo(context, remoteName)
    const result = remoteUrl ? parseGitHubOwnerRepo(remoteUrl) : null
    if (result) {
      ownerRepoCache.set(cacheKey, {
        value: result,
        expiresAt: now + OWNER_REPO_CACHE_TTL_MS
      })
      pruneOwnerRepoCache(now)
      return result
    }
  } catch {
    // ignore — non-GitHub remote or no remote
  }
  ownerRepoCache.set(cacheKey, { value: null, expiresAt: now + OWNER_REPO_CACHE_TTL_MS })
  pruneOwnerRepoCache(now)
  return null
}

export async function getOwnerRepo(
  repoPath: string,
  connectionId?: string | null
): Promise<OwnerRepo | null> {
  return getOwnerRepoForRemote(repoPath, 'origin', connectionId)
}

export async function getIssueOwnerRepo(
  repoPath: string,
  connectionId?: string | null
): Promise<OwnerRepo | null> {
  const upstream = await getOwnerRepoForRemote(repoPath, 'upstream', connectionId)
  if (upstream) {
    return upstream
  }
  return getOwnerRepoForRemote(repoPath, 'origin', connectionId)
}

export type PRRepositoryCandidates = {
  candidates: OwnerRepo[]
  headRepo: OwnerRepo | null
}

function ownerRepoKey(ownerRepo: OwnerRepo): string {
  return `${ownerRepo.owner.toLowerCase()}/${ownerRepo.repo.toLowerCase()}`
}

export async function resolvePRRepositoryCandidates(
  repoPath: string,
  connectionId?: string | null
): Promise<PRRepositoryCandidates> {
  const upstream = await getOwnerRepoForRemote(repoPath, 'upstream', connectionId)
  const origin = await getOwnerRepoForRemote(repoPath, 'origin', connectionId)
  const seen = new Set<string>()
  const candidates: OwnerRepo[] = []

  for (const candidate of [upstream, origin]) {
    if (!candidate) {
      continue
    }
    const key = ownerRepoKey(candidate)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    candidates.push(candidate)
  }

  return { candidates, headRepo: origin }
}

export type ResolvedIssueSource = {
  source: OwnerRepo | null
  /** True when the user preferred `upstream` but the upstream remote is no
   *  longer configured and the resolver fell back to origin. Consumers
   *  surface this as a one-time toast per session/repo. */
  fellBack: boolean
}

/**
 * Resolve the issue source for a repo honoring the user's per-repo preference.
 *
 * Do not delete `getIssueOwnerRepo`: it remains the right primitive for
 * `'auto'` mode and for preference-agnostic callers like typed work-item
 * detail lookups (where the issue-vs-PR disambiguation is orthogonal to
 * user choice).
 */
export async function resolveIssueSource(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId?: string | null
): Promise<ResolvedIssueSource> {
  if (preference === 'upstream') {
    const upstream = await getOwnerRepoForRemote(repoPath, 'upstream', connectionId)
    if (upstream) {
      return { source: upstream, fellBack: false }
    }
    // Why: explicit upstream is gone — fall back to origin but only flag the
    // fallback when it actually produced an origin source. If origin is also
    // missing (or non-GitHub), there's nothing to "fall back to" and the
    // UI toast "using origin" would be misleading. Do NOT auto-reset the
    // preference: the user may be mid-way through a workflow and expect
    // their choice to re-engage if `upstream` is re-added.
    const origin = await getOwnerRepoForRemote(repoPath, 'origin', connectionId)
    return { source: origin, fellBack: origin !== null }
  }
  if (preference === 'origin') {
    return {
      source: await getOwnerRepoForRemote(repoPath, 'origin', connectionId),
      fellBack: false
    }
  }
  // 'auto' or undefined
  return { source: await getIssueOwnerRepo(repoPath, connectionId), fellBack: false }
}
