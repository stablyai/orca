import { execFile } from 'child_process'
import { promisify } from 'util'
import { gitExecFileAsync, ghExecFileAsync } from '../git/runner'
import type { ClassifiedError } from '../../shared/types'

// Why: legacy generic execFile wrapper — only used by callers that don't need
// WSL-aware routing (e.g. non-repo-scoped gh commands). Repo-scoped callers
// should use ghExecFileAsync or gitExecFileAsync from the runner instead.
export const execFileAsync = promisify(execFile)
export { ghExecFileAsync, gitExecFileAsync }

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

// ── Error classification ─────────────────────────────────────────────
// Why: gh CLI surfaces API errors as unstructured stderr. This helper maps
// known patterns to typed errors so callers can show user-friendly messages.
export function classifyGhError(stderr: string): ClassifiedError {
  const s = stderr.toLowerCase()
  if (s.includes('http 403') || s.includes('resource not accessible')) {
    return {
      type: 'permission_denied',
      message: "You don't have permission to edit this issue. Check your GitHub token scopes."
    }
  }
  if (s.includes('http 404') || s.includes('could not resolve')) {
    return { type: 'not_found', message: 'Issue not found — it may have been deleted.' }
  }
  if (s.includes('http 422') || s.includes('validation failed')) {
    return { type: 'validation_error', message: `Invalid update — ${stderr.trim()}` }
  }
  if (s.includes('rate limit')) {
    return {
      type: 'rate_limited',
      message: 'GitHub rate limit hit. Try again in a few minutes.'
    }
  }
  if (s.includes('timeout') || s.includes('no such host') || s.includes('network')) {
    return { type: 'network_error', message: 'Network error — check your connection.' }
  }
  return { type: 'unknown', message: `Failed to update issue: ${stderr.trim()}` }
}

// ── Owner/repo resolution for gh api --cache ──────────────────────────
export type OwnerRepo = { owner: string; repo: string }

const ownerRepoCache = new Map<string, OwnerRepo | null>()

/** @internal — exposed for tests only */
export function _resetOwnerRepoCache(): void {
  ownerRepoCache.clear()
}

export function parseGitHubOwnerRepo(remoteUrl: string): OwnerRepo | null {
  const match = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!match) {
    return null
  }
  return { owner: match[1], repo: match[2] }
}

async function getOwnerRepoForRemote(
  repoPath: string,
  remoteName: string
): Promise<OwnerRepo | null> {
  const cacheKey = `${repoPath}\0${remoteName}`
  if (ownerRepoCache.has(cacheKey)) {
    return ownerRepoCache.get(cacheKey)!
  }
  try {
    const { stdout } = await gitExecFileAsync(['remote', 'get-url', remoteName], {
      cwd: repoPath
    })
    const result = parseGitHubOwnerRepo(stdout)
    if (result) {
      ownerRepoCache.set(cacheKey, result)
      return result
    }
  } catch {
    // ignore — non-GitHub remote or no remote
  }
  ownerRepoCache.set(cacheKey, null)
  return null
}

export async function getOwnerRepo(repoPath: string): Promise<OwnerRepo | null> {
  return getOwnerRepoForRemote(repoPath, 'origin')
}

export async function getIssueOwnerRepo(repoPath: string): Promise<OwnerRepo | null> {
  const upstream = await getOwnerRepoForRemote(repoPath, 'upstream')
  if (upstream) {
    return upstream
  }
  return getOwnerRepoForRemote(repoPath, 'origin')
}
