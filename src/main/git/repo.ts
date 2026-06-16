/* oxlint-disable max-lines */
import { execSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { basename } from 'path'
import { gitExecFileSync, gitExecFileAsync } from './runner'
import type { BaseRefSearchResult } from '../../shared/types'
import {
  buildHostedRemoteCommitUrl,
  buildHostedRemoteFileUrl,
  parseHostedRemote
} from './hosted-remote-url'
import { normalizeGitUsername } from './git-username'

const GH_LOGIN_TIMEOUT_MS = 2500

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
    const insideWorkTree = gitExecFileSync(['rev-parse', '--is-inside-work-tree'], {
      cwd: path
    }).trim()
    if (insideWorkTree === 'true') {
      return true
    }
  } catch {
    // Fall through to the bare-repo probe below.
  }

  try {
    const bareRepo = gitExecFileSync(['rev-parse', '--is-bare-repository'], {
      cwd: path
    }).trim()
    return bareRepo === 'true'
  } catch {
    return false
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
    return getRemoteUrlByName(path, 'origin')
  } catch {
    return null
  }
}

function getRemoteUrlByName(path: string, remote: string): string {
  return gitExecFileSync(['remote', 'get-url', remote], {
    cwd: path
  }).trim()
}

function listRemoteNamesSync(path: string): string[] {
  try {
    return gitExecFileSync(['remote'], { cwd: path })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function getConfiguredBranchRemote(path: string, branch: string | null): string {
  if (!branch) {
    return ''
  }
  const remote = getGitConfigValue(path, `branch.${branch}.remote`)
  return remote === '.' ? '' : remote
}

function getCurrentBranchName(path: string): string {
  try {
    return gitExecFileSync(['branch', '--show-current'], { cwd: path }).trim()
  } catch {
    return ''
  }
}

function getRemoteNameFromRef(shortRef: string, remotes: readonly string[]): string {
  const sortedRemotes = [...remotes].sort((a, b) => b.length - a.length)
  return sortedRemotes.find((remote) => shortRef.startsWith(`${remote}/`)) ?? ''
}

function getDefaultBranchName(shortRef: string, remoteName: string): string {
  if (!shortRef.includes('/')) {
    return shortRef
  }
  return remoteName ? shortRef.slice(remoteName.length + 1) : shortRef.split('/').slice(1).join('/')
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

let cachedGhLogin: string | undefined

function isGhProbeTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const err = error as { code?: unknown; message?: unknown }
  return (
    err.code === 'ETIMEDOUT' ||
    (typeof err.message === 'string' && /\bETIMEDOUT\b|timed out/i.test(err.message))
  )
}

function getGhLogin(): string {
  if (cachedGhLogin !== undefined) {
    return cachedGhLogin
  }

  try {
    const apiLogin = execSync('gh api user -q .login', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GH_LOGIN_TIMEOUT_MS
    }).trim()
    if (apiLogin) {
      cachedGhLogin = normalizeGitUsername(apiLogin)
      return cachedGhLogin
    }
  } catch (err) {
    if (isGhProbeTimeout(err)) {
      // Why: if `gh api user` timed out, `gh auth status` is likely to hit the
      // same stuck keychain/network path. Keep repo creation bounded to one probe.
      cachedGhLogin = ''
      return ''
    }
    // Fall through to auth status parsing
  }

  try {
    // Why: gh auth status writes to stderr; redirect via shell so we can capture it.
    // Use platform-appropriate shell — /bin/bash does not exist on Windows.
    const output = execSync('gh auth status 2>&1', {
      encoding: 'utf-8',
      shell: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/bash',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GH_LOGIN_TIMEOUT_MS
    })

    const activeAccountMatch = output.match(
      /Active account:\s+true[\s\S]*?account\s+([A-Za-z0-9-]+)/
    )
    if (activeAccountMatch?.[1]) {
      cachedGhLogin = normalizeGitUsername(activeAccountMatch[1])
      return cachedGhLogin
    }

    const accountMatch = output.match(/Logged in to github\.com account\s+([A-Za-z0-9-]+)/)
    const login = normalizeGitUsername(accountMatch?.[1] ?? '')
    if (login) {
      cachedGhLogin = login
    }
    return login
  } catch {
    // Why: broken tokens/keychains can block the Electron main process.
    // Keep the fallback best-effort for this app session.
    cachedGhLogin = ''
    return ''
  }
}

function getGhLoginForGitHubRemote(path: string): string {
  const remoteUrl = getGitHubRemoteUrlForGhLogin(path)
  if (!remoteUrl) {
    return ''
  }
  return getGhLogin()
}

function getGitHubRemoteUrlForGhLogin(path: string): string {
  const remotes = listRemoteNamesSync(path)
  const defaultBaseRef = getDefaultBaseRef(path)
  const defaultBaseRemote = defaultBaseRef ? getRemoteNameFromRef(defaultBaseRef, remotes) : ''
  const defaultBranch = defaultBaseRef
    ? getDefaultBranchName(defaultBaseRef, defaultBaseRemote)
    : null

  const candidateRemotes = [
    getConfiguredBranchRemote(path, getCurrentBranchName(path)),
    getConfiguredBranchRemote(path, defaultBranch),
    defaultBaseRemote,
    'origin',
    remotes.length === 1 ? remotes[0] : ''
  ]

  const seen = new Set<string>()
  for (const remote of candidateRemotes) {
    if (!remote || seen.has(remote)) {
      continue
    }
    seen.add(remote)
    try {
      const remoteUrl = getRemoteUrlByName(path, remote)
      if (parseHostedRemote(remoteUrl)?.provider === 'github') {
        return remoteUrl
      }
    } catch {
      // Missing candidate remotes are expected; try the next repo-level fallback.
    }
  }
  // Why: `gh` reports a GitHub account. For GitLab/Bitbucket/self-hosted
  // repos, using that identity would create the wrong provider prefix.
  return ''
}

/**
 * Get the GitHub/explicit username-style branch prefix for the repo.
 */
export function getGitUsername(path: string): string {
  // Why: this backs the "Git Username" branch-prefix setting. Commit author
  // email/name are not hosted-account usernames, so keep them out of this path.
  return normalizeGitUsername(
    getGitConfigValue(path, 'github.user') ||
      getGitConfigValue(path, 'user.username') ||
      getGhLoginForGitHubRemote(path)
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
 * Return { ahead, behind } for localRef vs remoteRef, or null on git failure.
 *
 * Why: `rev-list --left-right --count A...B` emits `<ahead>\t<behind>` —
 * ahead = commits on A not reachable from B; behind = commits on B not
 * reachable from A. This is the merge-base-symmetric delta used by the
 * stale-base dispatch guard (§3.1). Returning null on any failure (bad
 * ref, corrupt repo, non-numeric output) lets callers degrade gracefully
 * instead of failing dispatch on a probe error.
 */
export function getRemoteDrift(
  repoPath: string,
  localRef: string,
  remoteRef: string
): { ahead: number; behind: number } | null {
  try {
    const stdout = gitExecFileSync(
      ['rev-list', '--left-right', '--count', `${localRef}...${remoteRef}`],
      { cwd: repoPath }
    )
    const [aheadStr, behindStr] = stdout.trim().split(/\s+/)
    const ahead = Number(aheadStr)
    const behind = Number(behindStr)
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
      return null
    }
    return { ahead, behind }
  } catch {
    return null
  }
}

/**
 * Up to `limit` commit subjects present on remoteRef but not localRef, in
 * recency order. Returns [] on git failure.
 *
 * Why: powers the preamble drift section (§3.2) so a worker dispatched
 * against an acknowledged-stale base can see at a glance whether the
 * drift touches their task area.
 */
export function getRecentDriftSubjects(
  repoPath: string,
  localRef: string,
  remoteRef: string,
  limit: number
): string[] {
  try {
    const stdout = gitExecFileSync(
      ['log', '--format=%s', '-n', String(limit), `${localRef}..${remoteRef}`],
      { cwd: repoPath }
    )
    return stdout.split('\n').filter((s) => s.trim().length > 0)
  } catch {
    return []
  }
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
 * Why paired leaf/ancestor globs for a single-segment query: `git for-each-ref`
 * uses fnmatch-style globs where `*` does NOT cross `/`. Slash-named branch
 * refs need an ancestor-segment glob for `user` in `user/feature`, a leaf glob
 * for `feature`, and the same remote-side shape so typing a remote name like
 * `upstream` keeps working.
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
const REF_SEARCH_CANDIDATE_MULTIPLIER = 4
const REF_SEARCH_LEGACY_HEADROOM = 100

function getRefSearchCandidateCount(limit: number, excludesRemoteHead: boolean): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('invalid_limit')
  }
  const baseCount = limit * REF_SEARCH_CANDIDATE_MULTIPLIER
  return excludesRemoteHead ? baseCount : baseCount + REF_SEARCH_LEGACY_HEADROOM
}

export function buildSearchBaseRefsArgv(
  normalizedQuery: string,
  limit: number,
  options: { excludeRemoteHead?: boolean } = {}
): string[] {
  const excludeRemoteHead = options.excludeRemoteHead ?? true
  const candidateCount = getRefSearchCandidateCount(limit, excludeRemoteHead)
  const base = [
    'for-each-ref',
    '--format=%(refname)%00%(refname:short)',
    '--sort=-committerdate',
    ...(excludeRemoteHead
      ? [
          // Why: exclude remote HEAD pseudo-refs before --count so the bounded
          // candidate window is spent on refs the picker can actually display.
          '--exclude=refs/remotes/**/HEAD'
        ]
      : []),
    // Why: empty Branch-tab searches use broad globs; cap git output before
    // execFile/SSH buffers capture every ref in very large repositories.
    `--count=${candidateCount}`
  ]
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
    // Why `**`, not `*`: git for-each-ref globs are fnmatch-style where a
    // single `*` does NOT cross `/`. Slash-named branches (`user/feature`)
    // are the norm, so match both leaf and ancestor branch-name segments.
    // The remote ancestor glob also preserves remote-name queries like
    // `upstream` while `**/` keeps flat names like `main` working.
    return [
      ...base,
      `refs/heads/**/*${q}*`,
      `refs/heads/**/*${q}*/**`,
      `refs/remotes/**/*${q}*`,
      `refs/remotes/**/*${q}*/**`
    ]
  }
  // Why: multi-token queries like `upstream/main` map one `*token*` per
  // ref segment, so each token is matched within a single git ref
  // segment (fnmatch `*` cannot cross `/`). The picker displays results
  // as `<remote>/<branch>`, so users naturally retype that format; this
  // branch is what makes re-typing a visible result actually find it.
  const segmented = tokens.map((token) => `*${token}*`).join('/')
  return [...base, `refs/remotes/${segmented}`, `refs/heads/${segmented}`]
}

export function isForEachRefExcludeUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const maybe = error as { message?: unknown; stderr?: unknown; stdout?: unknown }
  const text = [maybe.message, maybe.stderr, maybe.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase()
  return text.includes('unknown option') && text.includes('exclude')
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
  return (await searchBaseRefDetails(path, query, limit)).map((entry) => entry.refName)
}

export async function searchBaseRefDetails(
  path: string,
  query: string,
  limit = 25
): Promise<BaseRefSearchResult[]> {
  if (!Number.isInteger(limit) || limit <= 0) {
    return []
  }
  const normalizedQuery = normalizeRefSearchQuery(query)

  try {
    // Why: argv (including the two-remote-glob rationale) lives in
    // buildSearchBaseRefsArgv so the SSH sibling cannot drift.
    const remotesPromise = listRemoteNames(path)
    let result: { stdout: string }
    try {
      result = await gitExecFileAsync(buildSearchBaseRefsArgv(normalizedQuery, limit), {
        cwd: path
      })
    } catch (err) {
      if (!isForEachRefExcludeUnsupportedError(err)) {
        throw err
      }
      result = await gitExecFileAsync(
        buildSearchBaseRefsArgv(normalizedQuery, limit, { excludeRemoteHead: false }),
        { cwd: path }
      )
    }
    const remotes = await remotesPromise

    return parseAndFilterSearchRefDetails(result.stdout, limit, remotes)
  } catch (err) {
    // Why: surface the failure for diagnostics; callers treat `[]` as "no
    // matches", but silently swallowing the error makes a missing result
    // set impossible to debug. Mirrors the SSH sibling in
    // src/main/ipc/repos.ts.
    console.warn('[searchBaseRefs] for-each-ref failed', { path, err })
    return []
  }
}

async function listRemoteNames(path: string): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync(['remote'], { cwd: path })
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
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
  return parseAndFilterSearchRefDetails(stdout, limit).map((entry) => entry.refName)
}

export function parseAndFilterSearchRefDetails(
  stdout: string,
  limit: number,
  remotes: string[] = []
): BaseRefSearchResult[] {
  const seen = new Set<string>()
  const sortedRemotes = [...remotes].sort((a, b) => b.length - a.length)
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
      .map(({ full, short }) => ({
        refName: short,
        localBranchName: resolveLocalBranchName(full, short, sortedRemotes)
      }))
      // Why: `Math.max(0, limit)` — treat pathological `limit <= 0` as
      // "zero results" rather than "at least 1". More honest than silently
      // returning a single ref when the caller explicitly asked for none.
      .slice(0, Math.max(0, limit))
  )
}

function resolveLocalBranchName(fullRef: string, shortRef: string, remotes: string[]): string {
  const remoteRefPrefix = 'refs/remotes/'
  if (!fullRef.startsWith(remoteRefPrefix)) {
    return shortRef
  }
  const remoteAndBranch = fullRef.slice(remoteRefPrefix.length)
  const remote = remotes.find((candidate) => remoteAndBranch.startsWith(`${candidate}/`))
  if (remote) {
    return remoteAndBranch.slice(remote.length + 1)
  }
  return remoteAndBranch.split('/').slice(1).join('/') || shortRef
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
  branchName: string,
  allowedBaseRef?: string
): Promise<BranchConflictKind | null> {
  if (await hasGitRefAsync(path, `refs/heads/${branchName}`)) {
    return 'local'
  }

  try {
    const remoteNames = (await listRemoteNames(path)).sort((a, b) => b.length - a.length)
    const { stdout } = await gitExecFileAsync(
      ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
      { cwd: path }
    )
    const hasRemoteConflict = stdout.split('\n').some((ref) => {
      const trimmed = ref.trim()
      if (isAllowedRemoteBaseRef(trimmed, allowedBaseRef)) {
        return false
      }
      const shortRef = trimmed.replace(/^refs\/remotes\//, '')
      // Why: git allows slashes in remote names. Use the configured remote
      // list so foo/bar/feature resolves as branch "feature" for remote
      // "foo/bar", matching searchBaseRefDetails.
      return resolveLocalBranchName(trimmed, shortRef, remoteNames) === branchName
    })

    return hasRemoteConflict ? 'remote' : null
  } catch {
    return null
  }
}

function isAllowedRemoteBaseRef(refName: string, allowedBaseRef: string | undefined): boolean {
  if (!allowedBaseRef) {
    return false
  }
  const normalizedAllowedRef = allowedBaseRef.startsWith('refs/remotes/')
    ? allowedBaseRef
    : `refs/remotes/${allowedBaseRef}`
  return refName === normalizedAllowedRef
}

/**
 * Build a hosted URL (e.g. GitHub, GitLab, Bitbucket) for a specific file
 * and line in the repo. Returns null when the remote isn't a recognized host.
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

  const defaultBaseRef = getDefaultBaseRef(repoPath)
  if (!defaultBaseRef) {
    return null
  }
  const defaultBranch = defaultBaseRef.replace(/^origin\//, '')

  return buildHostedRemoteFileUrl(remoteUrl, relativePath, defaultBranch, line)
}

/**
 * Build a hosted URL (e.g. GitHub, GitLab, Bitbucket) for a commit. Returns
 * null when the origin remote isn't a recognized host.
 */
export function getRemoteCommitUrl(repoPath: string, sha: string): string | null {
  const remoteUrl = getRemoteUrl(repoPath)
  if (!remoteUrl) {
    return null
  }
  return buildHostedRemoteCommitUrl(remoteUrl, sha)
}
