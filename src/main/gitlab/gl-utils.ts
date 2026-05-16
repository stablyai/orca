import { execFile } from 'child_process'
import { promisify } from 'util'
import { gitExecFileAsync, glabExecFileAsync } from '../git/runner'
import type { ClassifiedError, GitLabProjectRef, IssueSourcePreference } from '../../shared/types'

// Why: legacy generic execFile wrapper — only used by callers that don't need
// WSL-aware routing. Repo-scoped callers should use glabExecFileAsync from
// the runner instead.
export const execFileAsync = promisify(execFile)
export { glabExecFileAsync, gitExecFileAsync }

// ── Concurrency limiter — max 4 parallel glab processes ─────────────
// Why: parallel to gh-utils' limiter. Separate state from the gh limiter
// because gh and glab are independent binaries; one provider's spawns
// shouldn't throttle the other's. Cap matches gh-utils for consistency.
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
// Why: glab CLI surfaces API errors as unstructured stderr — same shape
// as gh. Map known GitLab patterns to typed errors so callers can show
// user-friendly messages.
export function classifyGlabError(stderr: string): ClassifiedError {
  const s = stderr.toLowerCase()
  if (s.includes('http 403') || s.includes('forbidden') || s.includes('insufficient_scope')) {
    return {
      type: 'permission_denied',
      message: "You don't have permission to edit this issue. Check your GitLab token scopes."
    }
  }
  if (s.includes('http 404') || s.includes('project not found')) {
    return { type: 'not_found', message: 'Issue not found — it may have been deleted.' }
  }
  if (s.includes('http 422') || s.includes('unprocessable')) {
    return { type: 'validation_error', message: `Invalid update — ${stderr.trim()}` }
  }
  // Why: GitLab returns 429 for rate limit; gh's "rate limit" stderr substring
  // also fires through the user-mode token bucket. Cover both.
  if (s.includes('rate limit') || s.includes('http 429')) {
    return {
      type: 'rate_limited',
      message: 'GitLab rate limit hit. Try again in a few minutes.'
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

// Why: classifyGlabError's copy is phrased for edit/update operations;
// listIssues is a read op. Rewrite the message for read contexts while
// keeping the typed classification intact for callers/telemetry.
export function classifyListIssuesError(stderr: string): ClassifiedError {
  const c = classifyGlabError(stderr)
  const trimmed = stderr.trim()
  // Exhaustive map so newly added error types surface as a TS error here
  // rather than silently falling through to edit-phrased copy.
  const readMessages: Record<ClassifiedError['type'], string> = {
    permission_denied:
      "You don't have permission to read issues for this project. Check your GitLab token scopes.",
    not_found: 'Project not found.',
    issues_disabled: 'Issues are disabled on this project.',
    validation_error: `Invalid request — ${trimmed}`,
    rate_limited: 'GitLab rate limit hit. Try again in a few minutes.',
    network_error: 'Network error — check your connection.',
    unknown: `Failed to load issues: ${trimmed}`
  }
  return { type: c.type, message: readMessages[c.type] }
}

// ── Project ref resolution ──────────────────────────────────────────
// Why: alias the shared shape so `src/shared/types.ts#GitLabProjectRef`
// remains the single source of truth while main-side call sites can use
// the short local name `ProjectRef`.
export type ProjectRef = GitLabProjectRef

const projectRefCache = new Map<string, ProjectRef | null>()

/** @internal — exposed for tests only */
export function _resetProjectRefCache(): void {
  projectRefCache.clear()
}

/**
 * Hosts always treated as GitLab. Self-hosted instances are added at
 * runtime via `getGlabKnownHosts()`, which inspects `glab auth status`.
 */
export const DEFAULT_GITLAB_HOSTS = ['gitlab.com'] as const

function normalizeHost(value: string): string {
  return value.trim().toLowerCase()
}

function stripGitSuffix(path: string): string {
  return path.replace(/\.git$/i, '')
}

function makeProjectRef(
  host: string,
  path: string,
  knownHosts: readonly string[]
): ProjectRef | null {
  const normalizedHost = normalizeHost(host)
  if (!knownHosts.map(normalizeHost).includes(normalizedHost)) {
    return null
  }
  const normalizedPath = stripGitSuffix(path.replace(/^\/+/, '')).trim()
  // Reject paths without at least one group segment — `gitlab.com:foo`
  // alone is not a project reference.
  if (!normalizedPath.includes('/')) {
    return null
  }
  return { host: normalizedHost, path: normalizedPath }
}

export function parseGitLabProjectRef(
  remoteUrl: string,
  knownHosts: readonly string[] = DEFAULT_GITLAB_HOSTS
): ProjectRef | null {
  const trimmed = remoteUrl.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^:\s/]+):([^\s]+?)(?:\.git)?$/)
    if (scpLike) {
      return makeProjectRef(scpLike[1], scpLike[2], knownHosts)
    }
  }

  try {
    const url = new URL(trimmed)
    if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    return makeProjectRef(url.hostname, url.pathname, knownHosts)
  } catch {
    return null
  }
}

export async function getProjectRefForRemote(
  repoPath: string,
  remoteName: string,
  knownHosts: readonly string[] = DEFAULT_GITLAB_HOSTS
): Promise<ProjectRef | null> {
  const cacheKey = `${repoPath}\0${remoteName}\0${knownHosts.join(',')}`
  if (projectRefCache.has(cacheKey)) {
    return projectRefCache.get(cacheKey)!
  }
  try {
    const { stdout } = await gitExecFileAsync(['remote', 'get-url', remoteName], {
      cwd: repoPath
    })
    const result = parseGitLabProjectRef(stdout, knownHosts)
    if (result) {
      projectRefCache.set(cacheKey, result)
      return result
    }
  } catch {
    // ignore — non-GitLab remote or no remote configured
  }
  projectRefCache.set(cacheKey, null)
  return null
}

export async function getProjectRef(
  repoPath: string,
  knownHosts?: readonly string[]
): Promise<ProjectRef | null> {
  return getProjectRefForRemote(repoPath, 'origin', knownHosts)
}

export async function getIssueProjectRef(
  repoPath: string,
  knownHosts?: readonly string[]
): Promise<ProjectRef | null> {
  const upstream = await getProjectRefForRemote(repoPath, 'upstream', knownHosts)
  if (upstream) {
    return upstream
  }
  return getProjectRefForRemote(repoPath, 'origin', knownHosts)
}

export type ResolvedIssueSource = {
  source: ProjectRef | null
  /** True when the user preferred `upstream` but the upstream remote is no
   *  longer configured and the resolver fell back to origin. */
  fellBack: boolean
}

/**
 * Resolve the issue source for a repo honoring the user's per-repo
 * preference. Mirrors `resolveIssueSource` in gh-utils — the upstream/
 * origin/auto semantics are git-remote concepts, not GitHub-specific.
 */
export async function resolveIssueSource(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  knownHosts?: readonly string[]
): Promise<ResolvedIssueSource> {
  if (preference === 'upstream') {
    const upstream = await getProjectRefForRemote(repoPath, 'upstream', knownHosts)
    if (upstream) {
      return { source: upstream, fellBack: false }
    }
    const origin = await getProjectRefForRemote(repoPath, 'origin', knownHosts)
    return { source: origin, fellBack: origin !== null }
  }
  if (preference === 'origin') {
    return {
      source: await getProjectRefForRemote(repoPath, 'origin', knownHosts),
      fellBack: false
    }
  }
  return { source: await getIssueProjectRef(repoPath, knownHosts), fellBack: false }
}

// ── Known-hosts discovery via `glab auth status` ────────────────────
// Why: glab supports multiple hosts (gitlab.com plus self-hosted). The
// authoritative list of "what counts as GitLab" from the user's POV is
// "what hosts have I authenticated with". Parse hostnames out of
// `glab auth status` output and cache the result process-wide.

let knownHostsCache: readonly string[] | null = null

/** @internal — exposed for tests only */
export function _resetKnownHostsCache(): void {
  knownHostsCache = null
}

export async function getGlabKnownHosts(): Promise<readonly string[]> {
  if (knownHostsCache) {
    return knownHostsCache
  }
  try {
    const { stdout, stderr } = await glabExecFileAsync(['auth', 'status'])
    // Why: glab writes auth status to stderr in some versions, stdout in
    // others. Concatenate so the parser sees both.
    const hosts = parseGlabAuthStatusHosts(`${stdout}\n${stderr}`)
    // Always include gitlab.com so a fresh-install user with no auth
    // still recognizes the canonical host.
    const merged = Array.from(new Set([...DEFAULT_GITLAB_HOSTS, ...hosts]))
    knownHostsCache = merged
    return merged
  } catch {
    // Auth check failed (glab not installed, no auth, etc.) — fall back
    // to the canonical default. The caller will hit the auth error on
    // the first real request anyway.
    knownHostsCache = [...DEFAULT_GITLAB_HOSTS]
    return knownHostsCache
  }
}

// ── Paginated `glab api -i` helper ──────────────────────────────────
// Why: GitLab returns total counts via response headers (X-Total,
// X-Total-Pages) on paginated REST endpoints. `glab api` discards
// headers by default; passing `-i` includes the raw HTTP response
// before the JSON body. Parse out the headers + body so callers can
// surface "Page X of Y" UIs without hand-rolling a second count call.

export type GlabApiResponse = {
  body: string
  headers: Record<string, string>
}

export async function glabApiWithHeaders(
  args: string[],
  options?: { cwd?: string }
): Promise<GlabApiResponse> {
  const { stdout } = await glabExecFileAsync(['api', '-i', ...args], options)
  return parseGlabApiResponse(stdout)
}

/** @internal — exported for tests. */
export function parseGlabApiResponse(stdout: string): GlabApiResponse {
  // Why: response is `HTTP/x.y status\nHeader: val\n…\n\n<body>`.
  // Match the first blank line (CRLF or LF) as the boundary.
  const sepMatch = stdout.match(/\r?\n\r?\n/)
  if (!sepMatch || sepMatch.index === undefined) {
    return { body: stdout, headers: {} }
  }
  const headerBlock = stdout.slice(0, sepMatch.index)
  const body = stdout.slice(sepMatch.index + sepMatch[0].length)
  const headers: Record<string, string> = {}
  // Skip the status line (HTTP/x.y …) and parse the rest as key: value.
  const lines = headerBlock.split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/)
    if (m) {
      headers[m[1].toLowerCase()] = m[2].trim()
    }
  }
  return { body, headers }
}

// Why: glab auth status output is human-formatted and varies across versions.
// Two patterns observed in the wild:
//   1) "✓ Logged in to gitlab.com as <user>"
//   2) "gitlab.example.com:" header followed by indented status lines
// Match both, dedupe, lowercase. Best-effort — anything that looks like a
// hostname.
export function parseGlabAuthStatusHosts(output: string): string[] {
  const hosts = new Set<string>()
  for (const m of output.matchAll(/logged in to ([a-zA-Z0-9.-]+)/gi)) {
    hosts.add(m[1].toLowerCase())
  }
  for (const line of output.split('\n')) {
    const m = line.match(/^([a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}):\s*$/)
    if (m) {
      hosts.add(m[1].toLowerCase())
    }
  }
  return Array.from(hosts)
}
