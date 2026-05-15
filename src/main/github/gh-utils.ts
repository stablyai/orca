import { execFile } from 'child_process'
import { promisify } from 'util'
import { gitExecFileAsync, ghExecFileAsync, extractExecError } from '../git/runner'
import type { ClassifiedError, GitHubOwnerRepo, IssueSourcePreference } from '../../shared/types'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'

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
  // Why: the full gh message is "Could not resolve to a Repository with the
  // name ...". Matching the substring 'could not resolve' alone would also
  // capture DNS failures like "could not resolve host: api.github.com" and
  // misclassify them as not_found. Anchor on the 'repository' qualifier so
  // DNS errors fall through to the network_error branch below.
  if (s.includes('http 404') || s.includes('could not resolve to a repository')) {
    return { type: 'not_found', message: 'Issue not found — it may have been deleted.' }
  }
  // Why: `gh issue list` prints "the '<owner>/<repo>' repository has disabled
  // issues" when Issues are turned off in repo settings (common on forks). This
  // hits during feature-2 when a user flips the selector to an origin fork —
  // without a dedicated branch the raw "Command failed: gh issue list …" line
  // leaks verbatim into the banner via the `unknown` fallback.
  if (s.includes('has disabled issues')) {
    return { type: 'issues_disabled', message: 'Issues are disabled on this repository.' }
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
  if (
    s.includes('timeout') ||
    s.includes('no such host') ||
    s.includes('network') ||
    s.includes('could not resolve host')
  ) {
    return { type: 'network_error', message: 'Network error — check your connection.' }
  }
  return { type: 'unknown', message: `Failed to update issue: ${stderr.trim()}` }
}

// Why: classifyGhError's copy is phrased for edit/update operations, but
// `listIssues` is a read op and the renderer interpolates err.message verbatim
// into a read-context banner. Rewrite the message for read contexts while
// keeping the typed classification so callers/telemetry are unaffected.
export function classifyListIssuesError(stderr: string): ClassifiedError {
  const c = classifyGhError(stderr)
  const trimmed = stderr.trim()
  // Why: provide an explicit entry for every `ClassifiedError['type']` value
  // (even when the copy matches the generic fallback) so the read-context
  // rewrite is complete and any newly added error type surfaces as a
  // TypeScript error rather than silently falling through to edit-phrased copy.
  const readMessages: Record<ClassifiedError['type'], string> = {
    permission_denied:
      "You don't have permission to read issues for this repository. Check your GitHub token scopes.",
    not_found: 'Repository not found.',
    issues_disabled: 'Issues are disabled on this repository.',
    validation_error: `Invalid request — ${trimmed}`,
    rate_limited: 'GitHub rate limit hit. Try again in a few minutes.',
    network_error: 'Network error — check your connection.',
    unknown: `Failed to load issues: ${trimmed}`
  }
  return { type: c.type, message: readMessages[c.type] }
}

// ── Owner/repo resolution for gh api --cache ──────────────────────────
// Why: alias the shared shape so `src/shared/types.ts#GitHubOwnerRepo` remains
// the single source of truth while main-side call sites can keep using the
// short local name `OwnerRepo`.
export type OwnerRepo = GitHubOwnerRepo

export type GitHubRemoteIdentity = GitHubOwnerRepo & { host: string }

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

const ownerRepoCache = new Map<string, OwnerRepo | null>()

/** @internal — exposed for tests only */
export function _resetOwnerRepoCache(): void {
  ownerRepoCache.clear()
}

export function parseGitHubOwnerRepo(remoteUrl: string): OwnerRepo | null {
  const identity = parseGitHubRemoteIdentity(remoteUrl)
  if (!identity || identity.host.toLowerCase() !== 'github.com') {
    return null
  }
  return { owner: identity.owner, repo: identity.repo }
}

export function parseGitHubRemoteIdentity(remoteUrl: string): GitHubRemoteIdentity | null {
  const trimmed = remoteUrl.trim()
  const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  if (httpsMatch) {
    return { host: httpsMatch[1], owner: httpsMatch[2], repo: httpsMatch[3] }
  }
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (sshMatch) {
    return { host: sshMatch[1], owner: sshMatch[2], repo: sshMatch[3] }
  }
  return null
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
  if (ownerRepoCache.has(cacheKey)) {
    return ownerRepoCache.get(cacheKey)!
  }
  try {
    const remoteUrl = await getRemoteUrlForRepo(context, remoteName)
    const result = remoteUrl ? parseGitHubOwnerRepo(remoteUrl) : null
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
