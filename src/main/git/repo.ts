/* oxlint-disable max-lines */
import { execSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import hostedGitInfo from 'hosted-git-info'
import { gitExecFileSync, gitExecFileAsync } from './runner'

/**
 * Ordered probe list used to resolve a repo's default base ref when no
 * explicit origin/HEAD symbolic-ref is set. `returnAs` is the short-name
 * format the UI expects (matches how `git for-each-ref --format=%(refname:short)`
 * would render the ref).
 *
 * Why: shared between the local path (getDefaultBaseRefAsync) and the SSH
 * relay path in src/main/ipc/repos.ts so both resolve identical defaults
 * for equivalent repo states.
 */
export const DEFAULT_BASE_REF_PROBES: readonly { ref: string; returnAs: string }[] = [
  { ref: 'refs/remotes/origin/main', returnAs: 'origin/main' },
  { ref: 'refs/remotes/origin/master', returnAs: 'origin/master' },
  { ref: 'refs/heads/main', returnAs: 'main' },
  { ref: 'refs/heads/master', returnAs: 'master' }
]

/**
 * Walk DEFAULT_BASE_REF_PROBES in order, returning the first ref whose
 * existence is confirmed by `hasRef`. Returns null if none exist.
 *
 * Why: abstracts the "how do we test a ref exists" detail so the local
 * path (hasGitRefAsync) and the SSH path (provider.exec rev-parse) can
 * share a single authoritative probe ordering.
 */
async function resolveDefaultBaseRefFromProbes(
  hasRef: (ref: string) => Promise<boolean>
): Promise<string | null> {
  for (const { ref, returnAs } of DEFAULT_BASE_REF_PROBES) {
    if (await hasRef(ref)) {
      return returnAs
    }
  }
  return null
}

/**
 * Check if a path is a valid git repository (regular or bare).
 */
export function isGitRepo(path: string): boolean {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return false
    }
    // .git dir or file (for worktrees) or bare repo
    if (existsSync(join(path, '.git'))) {
      return true
    }
    // Might be a bare repo — ask git
    const result = gitExecFileSync(['rev-parse', '--is-inside-work-tree'], {
      cwd: path
    }).trim()
    return result === 'true'
  } catch {
    // Also check if it's a bare repo
    try {
      const result = gitExecFileSync(['rev-parse', '--is-bare-repository'], {
        cwd: path
      }).trim()
      return result === 'true'
    } catch {
      return false
    }
  }
}

/**
 * Get a human-readable name for the repo from its path.
 */
export function getRepoName(path: string): string {
  const name = basename(path)
  // Strip .git suffix from bare repos
  return name.endsWith('.git') ? name.slice(0, -4) : name
}

/**
 * Get the remote origin URL, or null if not set.
 */
export function getRemoteUrl(path: string): string | null {
  try {
    return gitExecFileSync(['remote', 'get-url', 'origin'], {
      cwd: path
    }).trim()
  } catch {
    return null
  }
}

function getGitConfigValue(path: string, key: string): string {
  try {
    return gitExecFileSync(['config', '--get', key], {
      cwd: path
    }).trim()
  } catch {
    return ''
  }
}

function normalizeUsername(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  const localPart = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed
  return localPart.replace(/^\d+\+/, '')
}

let cachedGhLogin: string | undefined

function getGhLogin(): string {
  if (cachedGhLogin !== undefined) {
    return cachedGhLogin
  }

  try {
    const apiLogin = execSync('gh api user -q .login', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()
    if (apiLogin) {
      cachedGhLogin = normalizeUsername(apiLogin)
      return cachedGhLogin
    }
  } catch {
    // Fall through to auth status parsing
  }

  try {
    // Why: gh auth status writes to stderr; redirect via shell so we can capture it.
    // Use platform-appropriate shell — /bin/bash does not exist on Windows.
    const output = execSync('gh auth status 2>&1', {
      encoding: 'utf-8',
      shell: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/bash',
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const activeAccountMatch = output.match(
      /Active account:\s+true[\s\S]*?account\s+([A-Za-z0-9-]+)/
    )
    if (activeAccountMatch?.[1]) {
      cachedGhLogin = normalizeUsername(activeAccountMatch[1])
      return cachedGhLogin
    }

    const accountMatch = output.match(/Logged in to github\.com account\s+([A-Za-z0-9-]+)/)
    const login = normalizeUsername(accountMatch?.[1] ?? '')
    if (login) {
      cachedGhLogin = login
    }
    return login
  } catch {
    // Don't cache empty results on failure — allow retry on next call
    return ''
  }
}

/**
 * Get the best username-style branch prefix for the repo.
 */
export function getGitUsername(path: string): string {
  return normalizeUsername(
    getGitConfigValue(path, 'github.user') ||
      getGitConfigValue(path, 'user.username') ||
      getGhLogin() ||
      getGitConfigValue(path, 'user.email').split('@')[0] ||
      getGitConfigValue(path, 'user.name')
  )
}

function hasGitRef(path: string, ref: string): boolean {
  try {
    gitExecFileSync(['rev-parse', '--verify', ref], {
      cwd: path
    })
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the default base ref for new worktrees.
 * Prefer the remote primary branch over a potentially stale local branch.
 *
 * Why: returns `null` when no candidate ref is resolvable. Previously this
 * fell through to a hardcoded `'origin/main'` even when that ref did not
 * exist, which silently handed `git worktree add` a bad ref and produced
 * an opaque git error. Callers now fail loudly with a useful message, or
 * degrade gracefully for non-creation uses (e.g. hosted URL building).
 */
export function getDefaultBaseRef(path: string): string | null {
  try {
    const ref = gitExecFileSync(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
      cwd: path
    }).trim()

    if (ref) {
      return ref.replace(/^refs\/remotes\//, '')
    }
  } catch {
    // Fall through to explicit remote branch probes.
  }

  // Why: walk the shared DEFAULT_BASE_REF_PROBES list so the sync path and the
  // async/SSH paths cannot drift on which refs are tried or in what order.
  for (const { ref, returnAs } of DEFAULT_BASE_REF_PROBES) {
    if (hasGitRef(path, ref)) {
      return returnAs
    }
  }
  return null
}

export async function getBaseRefDefault(path: string): Promise<string | null> {
  return getDefaultBaseRefAsync(path)
}

/**
 * Parse `git remote` stdout into a count of configured remotes.
 *
 * Why: shared between the local path and the SSH relay path so the
 * count semantics cannot drift.
 */
export function parseRemoteCount(stdout: string): number {
  return stdout.split('\n').filter((line) => line.trim().length > 0).length
}

/**
 * Count the repo's configured remotes by shelling out `git remote`.
 * Returns 0 on error — callers use 0 as "unknown / do not render the
 * multi-remote hint", preserving today's no-hint behavior on failure.
 */
export async function getRemoteCount(path: string): Promise<number> {
  try {
    const { stdout } = await gitExecFileAsync(['remote'], { cwd: path })
    return parseRemoteCount(stdout)
  } catch (err) {
    // Why: surface the failure for diagnostics; callers treat 0 as "unknown /
    // do not render the multi-remote hint", but silently swallowing the error
    // makes a missing hint impossible to debug.
    console.warn('[getRemoteCount] git remote failed', { path, err })
    return 0
  }
}

/** Callback shape for a git exec function that yields stdout. */
export type GitExec = (argv: string[]) => Promise<{ stdout: string }>

/**
 * Resolve the default base ref given a git exec callback. Prefers
 * origin/HEAD's symbolic-ref target; falls back to DEFAULT_BASE_REF_PROBES.
 *
 * Why: shared between the local path (via gitExecFileAsync) and the SSH
 * relay path (via provider.exec) so both paths return identical results
 * for equivalent repo states. Accepting an exec callback avoids coupling
 * this helper to either transport. Callers that want transport-level
 * diagnostics should log inside their own exec callback before rethrowing —
 * this helper swallows symbolic-ref's catch because a non-zero exit is the
 * expected signal for "origin/HEAD is unset" and not distinguishable here
 * from a genuine transport failure.
 */
export async function resolveDefaultBaseRefViaExec(exec: GitExec): Promise<string | null> {
  try {
    const { stdout } = await exec(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    const ref = stdout.trim()
    if (ref) {
      return ref.replace(/^refs\/remotes\//, '')
    }
  } catch {
    // symbolic-ref returns non-zero when origin/HEAD is unset — expected.
    // Fall through to probes.
  }
  return resolveDefaultBaseRefFromProbes(async (ref) => {
    try {
      await exec(['rev-parse', '--verify', '--quiet', ref])
      return true
    } catch {
      return false
    }
  })
}

async function getDefaultBaseRefAsync(path: string): Promise<string | null> {
  return resolveDefaultBaseRefViaExec((argv) => gitExecFileAsync(argv, { cwd: path }))
}

/**
 * Build the argv for `git for-each-ref` used by ref search, given an
 * already-normalized query string.
 *
 * Why: glob `refs/remotes/*\/*` (not `refs/remotes/origin/*`) so fork
 * workflows can discover branches from any configured remote (e.g.
 * `upstream/main`). The picker would otherwise structurally deny the
 * correct answer for fork contributors — see docs/upstream-base-ref-design.md.
 *
 * Why two remote globs for a single-segment query: `git for-each-ref`
 * uses fnmatch-style globs where `*` does NOT cross `/`. A single
 * `refs/remotes/*\/*<q>*` pattern only matches when `<q>` appears in the
 * branch-name segment, so typing `upstream` (a remote name) would return
 * nothing. The extra `refs/remotes/*<q>*\/*` glob matches when the query
 * appears in the remote-name segment, making remote-name filtering work.
 *
 * Why the multi-segment branch: the picker displays results as
 * `upstream/main`, so users naturally retype that format. With a single
 * glob, `upstream/main` becomes `refs/remotes/*upstream/main*\/*` — five
 * path segments, zero matches. Splitting on `/` and emitting one
 * `*<token>*` per ref segment maps directly to git's ref structure
 * (`refs/remotes/<remote>/<branch>`, `refs/heads/<branch>`) and makes
 * display-format queries actually find the ref on screen.
 *
 * Why shared: the local path and the SSH relay path must send the exact
 * same argv so results cannot diverge between transports.
 */
export function buildSearchBaseRefsArgv(normalizedQuery: string): string[] {
  const base = ['for-each-ref', '--format=%(refname)%00%(refname:short)', '--sort=-committerdate']
  // Why: split on `/` so display-format queries (`upstream/main`) route
  // each token to one git ref segment. Filter empty tokens so trailing
  // (`upstream/`), leading (`/main`), or doubled (`upstream//main`)
  // slashes don't produce empty `**` segments that degrade to useless
  // patterns. A single remaining token means the user hasn't committed
  // to a remote-plus-branch query yet — route through the widened
  // single-segment globs below instead of pinning to one segment.
  const tokens = normalizedQuery.split('/').filter((t) => t.length > 0)
  if (tokens.length <= 1) {
    const q = tokens[0] ?? ''
    // Why three globs for a single-segment query: `git for-each-ref`
    // uses fnmatch-style globs where `*` does NOT cross `/`. A single
    // `refs/remotes/*\/*<q>*` only matches when `<q>` is in the branch
    // segment, so typing `upstream` (a remote name) returns nothing.
    // The extra `refs/remotes/*<q>*\/*` matches when the query lives in
    // the remote segment, making remote-name filtering work.
    return [...base, `refs/remotes/*${q}*/*`, `refs/remotes/*/*${q}*`, `refs/heads/*${q}*`]
  }
  // Why: multi-token queries like `upstream/main` map one `*token*` per
  // ref segment, so each token is matched within a single git ref
  // segment (fnmatch `*` cannot cross `/`). The picker displays results
  // as `<remote>/<branch>`, so users naturally retype that format; this
  // branch is what makes re-typing a visible result actually find it.
  const segmented = tokens.map((token) => `*${token}*`).join('/')
  return [...base, `refs/remotes/${segmented}`, `refs/heads/${segmented}`]
}

/**
 * Resolve the default push remote for a repo.
 * Order: remote configured on the current default branch → origin → the single
 * remote when the repo has exactly one → error.
 */
export async function getDefaultRemote(path: string): Promise<string> {
  const defaultRef = await getDefaultBaseRefAsync(path)
  // Why: getDefaultBaseRefAsync returns null when no default branch can be
  // detected (e.g. a brand-new repo with no commits on origin). Guard so we
  // don't crash on .includes(); fall through to the remote-list heuristics.
  const defaultBranch = defaultRef
    ? defaultRef.includes('/')
      ? defaultRef.split('/').slice(1).join('/')
      : defaultRef
    : null

  if (defaultBranch) {
    try {
      const { stdout } = await gitExecFileAsync(
        ['config', '--get', `branch.${defaultBranch}.remote`],
        { cwd: path }
      )
      const value = stdout.trim()
      if (value) {
        return value
      }
    } catch {
      // Fall through: branch has no explicit remote configured.
    }
  }

  try {
    const { stdout } = await gitExecFileAsync(['remote'], { cwd: path })
    const remotes = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (remotes.includes('origin')) {
      return 'origin'
    }
    if (remotes.length === 1) {
      return remotes[0]
    }
    if (remotes.length === 0) {
      throw new Error('Repo has no configured git remotes.')
    }
    throw new Error(
      `Repo has multiple remotes (${remotes.join(', ')}) and no default is configured. Set branch.<default>.remote.`
    )
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error('Failed to resolve default remote for repo.')
  }
}

export async function searchBaseRefs(path: string, query: string, limit = 25): Promise<string[]> {
  const normalizedQuery = normalizeRefSearchQuery(query)
  if (!normalizedQuery) {
    return []
  }

  try {
    // Why: argv (including the two-remote-glob rationale) lives in
    // buildSearchBaseRefsArgv so the SSH sibling cannot drift.
    const { stdout } = await gitExecFileAsync(buildSearchBaseRefsArgv(normalizedQuery), {
      cwd: path
    })

    return parseAndFilterSearchRefs(stdout, limit)
  } catch (err) {
    // Why: surface the failure for diagnostics; callers treat `[]` as "no
    // matches", but silently swallowing the error makes a missing result
    // set impossible to debug. Mirrors the SSH sibling in
    // src/main/ipc/repos.ts.
    console.warn('[searchBaseRefs] for-each-ref failed', { path, err })
    return []
  }
}

/**
 * Parse `git for-each-ref --format=%(refname)%00%(refname:short)` stdout
 * into a deduped list of short refs, filtering out `<remote>/HEAD`
 * pseudo-refs, honoring a limit.
 *
 * Why: shared between the local `searchBaseRefs` and the SSH branch in
 * `src/main/ipc/repos.ts` so both return identical, correctly-filtered
 * results. The same bug class (wrong filter ordering, HEAD leaking into
 * results, duplicate short refs) that motivated this helper originally
 * lived in a single location; two copies double the regression surface.
 */
export function parseAndFilterSearchRefs(stdout: string, limit: number): string[] {
  const seen = new Set<string>()
  return (
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const nul = line.indexOf('\0')
        if (nul < 0) {
          // Why: defensive fallback for an unlikely %(refname) format change.
          // Drop the entry — emitting a full refname as a "short" ref would
          // hand callers a ref they can't use (and would bypass the HEAD
          // filter below, since we could no longer tell a `<remote>/HEAD`
          // pseudo-ref from a local branch named `foo/HEAD`).
          return null
        }
        return { full: line.slice(0, nul), short: line.slice(nul + 1) }
      })
      .filter((entry): entry is { full: string; short: string } => entry !== null)
      // Why: drop `refs/remotes/<remote>/HEAD` pseudo-refs. Uses `.+` (not
      // `[^/]+`) because git allows slashes in remote names, so nested
      // remotes like `refs/remotes/foo/bar/HEAD` also match. A local branch
      // named `foo/HEAD` (rare but valid per git check-ref-format) is
      // preserved because its `full` is `refs/heads/foo/HEAD`, which does
      // not match this pattern.
      .filter(({ full }) => !/^refs\/remotes\/.+\/HEAD$/.test(full))
      .filter(({ short }) => {
        if (seen.has(short)) {
          return false
        }
        seen.add(short)
        return true
      })
      .map(({ short }) => short)
      // Why: `Math.max(0, limit)` — treat pathological `limit <= 0` as
      // "zero results" rather than "at least 1". More honest than silently
      // returning a single ref when the caller explicitly asked for none.
      .slice(0, Math.max(0, limit))
  )
}

export function normalizeRefSearchQuery(query: string): string {
  return query.trim().replace(/[*?[\]\\]/g, '')
}

async function hasGitRefAsync(path: string, ref: string): Promise<boolean> {
  try {
    await gitExecFileAsync(['rev-parse', '--verify', ref], { cwd: path })
    return true
  } catch {
    return false
  }
}

export type BranchConflictKind = 'local' | 'remote'

export async function getBranchConflictKind(
  path: string,
  branchName: string
): Promise<BranchConflictKind | null> {
  if (await hasGitRefAsync(path, `refs/heads/${branchName}`)) {
    return 'local'
  }

  try {
    const { stdout } = await gitExecFileAsync(
      ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
      { cwd: path }
    )
    // Why: refs have the form refs/remotes/<remote>/<branch>. We strip the
    // first three segments so that e.g. "feature/dashboard" only matches
    // "refs/remotes/origin/feature/dashboard", not "refs/remotes/origin/other/feature/dashboard".
    const hasRemoteConflict = stdout.split('\n').some((ref) => {
      const parts = ref.trim().split('/')
      return parts.slice(3).join('/') === branchName
    })

    return hasRemoteConflict ? 'remote' : null
  } catch {
    return null
  }
}

/**
 * Build a hosted URL (e.g. GitHub, GitLab, Bitbucket) for a specific file
 * and line in the repo. Returns null when the remote isn't a recognized host.
 *
 * Why hosted-git-info: it handles SSH, HTTPS, and shorthand remote URLs
 * across multiple providers, so we don't have to maintain our own URL parser.
 */
export function getRemoteFileUrl(
  repoPath: string,
  relativePath: string,
  line: number
): string | null {
  const remoteUrl = getRemoteUrl(repoPath)
  if (!remoteUrl) {
    return null
  }

  const info = hostedGitInfo.fromUrl(remoteUrl)
  if (!info) {
    return null
  }

  const defaultBaseRef = getDefaultBaseRef(repoPath)
  if (!defaultBaseRef) {
    return null
  }
  const defaultBranch = defaultBaseRef.replace(/^origin\//, '')
  const browseUrl = info.browseFile(relativePath, { committish: defaultBranch })
  if (!browseUrl) {
    return null
  }

  // Why: hosted-git-info lowercases the fragment, but GitHub convention
  // uses uppercase L for line links (e.g. #L42). Append manually.
  return `${browseUrl}#L${line}`
}
