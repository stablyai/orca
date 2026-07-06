/* oxlint-disable max-lines */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { gitExecFileSync, gitExecFileAsync } from './runner'
import type { BaseRefSearchResult } from '../../shared/types'
import { parseGitRevListAheadBehindCounts } from '../../shared/git-rev-list-output'
import { normalizeRuntimePathSeparators } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { buildHostedRemoteCommitUrl, buildHostedRemoteFileUrl } from './hosted-remote-url'

type LocalGitExecOptions = {
  wslDistro?: string
}

type GitRepoProbeResult = 'repo' | 'not-repo' | 'indeterminate'
type GitMarkerScanResult = { status: 'valid'; rootPath: string } | { status: 'absent' | 'invalid' }

function gitExecOptions(
  cwd: string,
  options: LocalGitExecOptions = {}
): { cwd: string; wslDistro?: string } {
  return options.wslDistro ? { cwd, wslDistro: options.wslDistro } : { cwd }
}

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
  } catch {
    return false
  }

  // Authoritative positive signal: ask git directly. Covers regular work
  // trees, linked worktrees (gitfile), submodules, and bare repos.
  const gitProbeResult = probeGitRepo(path)
  if (gitProbeResult === 'repo') {
    return true
  }
  if (gitProbeResult === 'not-repo') {
    return false
  }

  // Why: `git rev-parse` can fail to produce a clean answer for reasons
  // unrelated to repo-ness — a transient spawn failure or git-shim hiccup in
  // the packaged app, resource pressure in the Electron main process, or a
  // repo whose config errors out. Treating every such failure as "not a repo"
  // silently downgrades a real repository to a plain folder (worktrees, SCM,
  // PRs all disappear) and is the regression behind the spurious "Open as
  // Folder" prompt. Fall back to a validated `.git` marker so a directory that
  // genuinely carries Git metadata is still recognized; a directory with only
  // a garbage `.git` file has no valid marker and is correctly rejected.
  const markerScan = scanGitMarkerSync(path)
  if (markerScan.status === 'valid' && !warnedMarkerFallbackThisSession) {
    // Why: warn only once per session. The folder scanner calls isGitRepo for
    // many paths; if git is genuinely unavailable, warning per path would flood
    // the main-process logs without adding signal beyond the first occurrence.
    warnedMarkerFallbackThisSession = true
    console.warn('[isGitRepo] git rev-parse could not confirm repo; accepted via .git marker', {
      path
    })
  }
  return markerScan.status === 'valid'
}

let warnedMarkerFallbackThisSession = false

/**
 * Tri-state git probe: only a clean pair of negative answers is a definitive
 * non-repo. Spawn/config failures stay indeterminate so marker fallback can run.
 */
function probeGitRepo(path: string): GitRepoProbeResult {
  let sawFailure = false

  try {
    const insideWorkTree = gitExecFileSync(['rev-parse', '--is-inside-work-tree'], {
      cwd: path
    }).trim()
    if (insideWorkTree === 'true') {
      return 'repo'
    }
    if (insideWorkTree !== 'false') {
      return 'indeterminate'
    }
  } catch {
    sawFailure = true
  }

  try {
    const bareRepo = gitExecFileSync(['rev-parse', '--is-bare-repository'], {
      cwd: path
    }).trim()
    if (bareRepo === 'true') {
      return 'repo'
    }
    if (bareRepo !== 'false') {
      return 'indeterminate'
    }
  } catch {
    sawFailure = true
  }

  return sawFailure ? 'indeterminate' : 'not-repo'
}

export function getGitRepoRoot(path: string): string {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return path
    }
    const insideWorkTree = gitExecFileSync(['rev-parse', '--is-inside-work-tree'], {
      cwd: path
    }).trim()
    if (insideWorkTree === 'true') {
      const root = gitExecFileSync(['rev-parse', '--show-toplevel'], {
        cwd: path
      }).trim()
      return normalizeGitRepoRootForInputPath(path, root)
    }
  } catch {
    // Fall through to preserving the original path.
  }
  const markerScan = scanGitMarkerSync(path)
  if (markerScan.status === 'valid') {
    return normalizeGitRepoRootForInputPath(path, markerScan.rootPath)
  }
  return path
}

export function normalizeGitRepoRootForInputPath(inputPath: string, rootPath: string): string {
  const inputWsl = parseWslUncPath(inputPath)
  if (inputWsl && rootPath.startsWith('/')) {
    // Why: WSL git reports Linux-native roots; Orca must persist the UNC path so
    // later local git calls keep routing through the WSL-aware runner.
    return toWindowsWslPath(rootPath, inputWsl.distro)
  }
  return normalizeRuntimePathSeparators(rootPath)
}

/**
 * Filesystem-only check for genuine Git metadata, used as a fallback when git
 * cannot give a clean answer. Strict enough to reject a directory whose `.git`
 * is a garbage file (preserving the validation added in 18ed7b27d):
 * - `.git` directory: accepted only if it has real common or linked-worktree
 *   gitdir shape, so empty/incomplete `.git/` folders are rejected.
 * - `.git` file: accepted only if its `gitdir:` target resolves to valid Git
 *   metadata, covering linked worktrees and submodules.
 * - bare repo root: accepted when HEAD + objects/ + refs/ are present and the
 *   config does not mark it as a regular worktree admin dir.
 */
function scanGitMarkerSync(path: string): GitMarkerScanResult {
  const realPath = resolveRealPathSync(path)
  if (realPath && realPath !== path) {
    const lexicalScan = scanGitMarkerAncestorsSync(path)
    const realPathScan = scanGitMarkerAncestorsSync(realPath)
    if (
      lexicalScan.status === 'valid' &&
      realPathScan.status === 'valid' &&
      pathsReferToSameEntry(lexicalScan.rootPath, realPathScan.rootPath)
    ) {
      // Why: preserve lexical spellings such as /var vs /private/var, but let a
      // symlink from one repo into another bind to the real target repo like git.
      return lexicalScan
    }
    return realPathScan
  }
  return scanGitMarkerAncestorsSync(path)
}

function resolveRealPathSync(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return null
    }
  }
}

function scanGitMarkerAncestorsSync(path: string): GitMarkerScanResult {
  for (const candidate of ancestorDirectories(path)) {
    if (!isInsideDotGitMarker(candidate, path)) {
      const worktreeMarker = scanWorktreeMarkerSync(candidate)
      if (worktreeMarker.status !== 'absent') {
        return worktreeMarker
      }
    }
    if (hasValidBareRepoMarkerSync(candidate)) {
      return { status: 'valid', rootPath: candidate }
    }
  }
  return { status: 'absent' }
}

function ancestorDirectories(path: string): string[] {
  const directories: string[] = []
  let current = path
  while (true) {
    directories.push(current)
    const parent = dirname(current)
    if (parent === current) {
      return directories
    }
    current = parent
  }
}

function isInsideDotGitMarker(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return false
  }
  const firstSegment = relativePath.split(/[\\/]+/)[0]
  if (firstSegment === '.git') {
    return true
  }
  if (firstSegment.toLowerCase() !== '.git') {
    return false
  }
  return pathsReferToSameEntry(join(rootPath, firstSegment), join(rootPath, '.git'))
}

function pathsReferToSameEntry(leftPath: string, rightPath: string): boolean {
  try {
    const leftStat = statSync(leftPath)
    const rightStat = statSync(rightPath)
    if (leftStat.ino !== 0 && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) {
      return true
    }
    const leftRealPath = normalizeRuntimePathSeparators(realpathSync.native(leftPath))
    const rightRealPath = normalizeRuntimePathSeparators(realpathSync.native(rightPath))
    return process.platform === 'win32'
      ? leftRealPath.toLowerCase() === rightRealPath.toLowerCase()
      : leftRealPath === rightRealPath
  } catch {
    return false
  }
}

function scanWorktreeMarkerSync(worktreePath: string): GitMarkerScanResult {
  const dotGit = join(worktreePath, '.git')
  let marker: ReturnType<typeof statSync>
  try {
    marker = statSync(dotGit)
  } catch {
    return { status: 'absent' }
  }

  if (marker.isDirectory()) {
    return hasValidGitDirectorySync(dotGit)
      ? { status: 'valid', rootPath: worktreePath }
      : { status: 'invalid' }
  }
  if (marker.isFile()) {
    let gitDir: string | null
    try {
      gitDir = parseGitdirFile(worktreePath, readFileSync(dotGit, 'utf8'))
    } catch {
      return { status: 'invalid' }
    }
    return gitDir !== null && hasValidGitDirectorySync(gitDir)
      ? { status: 'valid', rootPath: worktreePath }
      : { status: 'invalid' }
  }
  return { status: 'invalid' }
}

function parseGitdirFile(basePath: string, content: string): string | null {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  const match = firstLine.match(/^gitdir:\s*(.+?)\s*$/i)
  if (!match) {
    return null
  }
  return resolveGitMetadataPath(basePath, match[1])
}

function resolveGitMetadataPath(basePath: string, rawPath: string): string | null {
  const value = rawPath.trim()
  if (!value) {
    return null
  }
  const baseWsl = parseWslUncPath(basePath)
  if (baseWsl && value.startsWith('/')) {
    return toWindowsWslPath(value, baseWsl.distro)
  }
  return isAbsolute(value) ? value : resolve(basePath, value)
}

function hasValidGitDirectorySync(gitDir: string): boolean {
  return hasValidCommonGitDirectorySync(gitDir) || hasValidLinkedWorktreeGitDirectorySync(gitDir)
}

function hasValidCommonGitDirectorySync(gitDir: string): boolean {
  try {
    return (
      statSync(join(gitDir, 'HEAD')).isFile() &&
      statSync(join(gitDir, 'objects')).isDirectory() &&
      statSync(join(gitDir, 'refs')).isDirectory()
    )
  } catch {
    return false
  }
}

function hasValidLinkedWorktreeGitDirectorySync(gitDir: string): boolean {
  try {
    if (!statSync(join(gitDir, 'HEAD')).isFile() || !statSync(join(gitDir, 'commondir')).isFile()) {
      return false
    }
    const commonDir = resolveGitMetadataPath(
      gitDir,
      readFileSync(join(gitDir, 'commondir'), 'utf8')
    )
    return commonDir !== null && hasValidCommonGitDirectorySync(commonDir)
  } catch {
    return false
  }
}

function hasValidBareRepoMarkerSync(path: string): boolean {
  return hasValidCommonGitDirectorySync(path) && !gitConfigDeclaresNonBare(path)
}

function gitConfigDeclaresNonBare(gitDir: string): boolean {
  try {
    const config = readFileSync(join(gitDir, 'config'), 'utf8')
    let inCoreSection = false
    for (const line of config.split(/\r?\n/)) {
      const section = line.match(/^\s*\[([^\]]+)\]/)
      if (section) {
        inCoreSection = section[1].trim().toLowerCase() === 'core'
        continue
      }
      const bare = line.match(/^\s*bare\s*=\s*(.*?)\s*$/i)
      if (inCoreSection && bare) {
        return isGitBooleanFalse(normalizeGitConfigValue(bare[1]))
      }
    }
    return false
  } catch {
    return false
  }
}

function normalizeGitConfigValue(value: string): string {
  const unescaped = stripGitConfigInlineComment(value).trim().replace(/\\"/g, '"')
  if (
    unescaped.length >= 2 &&
    ((unescaped.startsWith('"') && unescaped.endsWith('"')) ||
      (unescaped.startsWith("'") && unescaped.endsWith("'")))
  ) {
    return unescaped.slice(1, -1)
  }
  return unescaped
}

function stripGitConfigInlineComment(value: string): string {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' || char === ';') {
      return value.slice(0, i)
    }
  }
  return value
}

function isGitBooleanFalse(value: string): boolean {
  return ['', 'false', 'no', 'off', '0'].includes(value.toLowerCase())
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

function gitRefToDefaultBaseRef(ref: string): string {
  return ref.replace(/^refs\/remotes\//, '')
}

function getVerifiedOriginHeadBaseRef(path: string): string | null {
  try {
    const ref = gitExecFileSync(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
      cwd: path
    }).trim()

    // Why: origin/HEAD may survive a default-branch rename while pointing at a
    // deleted ref; verify before trusting it over the probe list.
    return ref && hasGitRef(path, ref) ? gitRefToDefaultBaseRef(ref) : null
  } catch {
    return null
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
  const originHeadBaseRef = getVerifiedOriginHeadBaseRef(path)
  if (originHeadBaseRef) {
    return originHeadBaseRef
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

export async function getBaseRefDefault(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string | null> {
  return getDefaultBaseRefAsync(path, options)
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
  remoteRef: string,
  options: LocalGitExecOptions = {}
): { ahead: number; behind: number } | null {
  try {
    const stdout = gitExecFileSync(
      ['rev-list', '--left-right', '--count', `${localRef}...${remoteRef}`],
      gitExecOptions(repoPath, options)
    )
    const counts = parseGitRevListAheadBehindCounts(stdout)
    if (counts.status !== 'ok') {
      return null
    }
    return { ahead: counts.ahead, behind: counts.behind }
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
  limit: number,
  options: LocalGitExecOptions = {}
): string[] {
  try {
    const stdout = gitExecFileSync(
      ['log', '--format=%s', '-n', String(limit), `${localRef}..${remoteRef}`],
      gitExecOptions(repoPath, options)
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

async function hasGitRefViaExec(exec: GitExec, ref: string): Promise<boolean> {
  try {
    await exec(['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

async function resolveVerifiedOriginHeadBaseRefViaExec(exec: GitExec): Promise<string | null> {
  try {
    const { stdout } = await exec(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    const ref = stdout.trim()
    if (!ref || !(await hasGitRefViaExec(exec, ref))) {
      return null
    }
    return gitRefToDefaultBaseRef(ref)
  } catch {
    return null
  }
}

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
  const originHeadBaseRef = await resolveVerifiedOriginHeadBaseRefViaExec(exec)
  if (originHeadBaseRef) {
    return originHeadBaseRef
  }
  return resolveDefaultBaseRefFromProbes((ref) => hasGitRefViaExec(exec, ref))
}

async function getDefaultBaseRefAsync(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string | null> {
  return resolveDefaultBaseRefViaExec((argv) =>
    gitExecFileAsync(argv, gitExecOptions(path, options))
  )
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

type RefSearchPatternGroup = 'all' | 'segmented' | 'branchRoot'

function getRefSearchTokens(normalizedQuery: string): string[] {
  return normalizedQuery.split('/').filter((t) => t.length > 0)
}

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
  options: {
    excludeRemoteHead?: boolean
    remoteNames?: readonly string[]
    patternGroup?: RefSearchPatternGroup
  } = {}
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
  const tokens = getRefSearchTokens(normalizedQuery)
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
  const substringQuery = tokens.join('/')
  const remoteBranchRootPatterns =
    options.remoteNames && options.remoteNames.length > 0
      ? options.remoteNames.flatMap((remote) => [
          `refs/remotes/${remote}/${substringQuery}*`,
          `refs/remotes/${remote}/${substringQuery}*/**`
        ])
      : [`refs/remotes/*/${substringQuery}*`, `refs/remotes/*/${substringQuery}*/**`]
  const segmentedPatterns = [`refs/remotes/${segmented}`, `refs/heads/${segmented}`]
  const branchRootPatterns = [
    // Why: branch names often contain slashes (`plan/docs`). Segment-wise
    // display-format globs only align with `<remote>/<branch>`; these root
    // patterns also match the local branch name beneath any configured remote.
    `refs/heads/${substringQuery}*`,
    `refs/heads/${substringQuery}*/**`,
    ...remoteBranchRootPatterns
  ]
  const patterns =
    options.patternGroup === 'segmented'
      ? segmentedPatterns
      : options.patternGroup === 'branchRoot'
        ? branchRootPatterns
        : [...segmentedPatterns, ...branchRootPatterns]
  return [...base, ...patterns]
}

async function runSearchBaseRefsGit(
  path: string,
  normalizedQuery: string,
  limit: number,
  options: { remoteNames: readonly string[]; patternGroup?: RefSearchPatternGroup }
): Promise<{ stdout: string }> {
  try {
    return await gitExecFileAsync(
      buildSearchBaseRefsArgv(normalizedQuery, limit, {
        remoteNames: options.remoteNames,
        patternGroup: options.patternGroup
      }),
      { cwd: path }
    )
  } catch (err) {
    if (!isForEachRefExcludeUnsupportedError(err)) {
      throw err
    }
    return gitExecFileAsync(
      buildSearchBaseRefsArgv(normalizedQuery, limit, {
        excludeRemoteHead: false,
        remoteNames: options.remoteNames,
        patternGroup: options.patternGroup
      }),
      { cwd: path }
    )
  }
}

export function mergeBaseRefSearchResultGroups(
  groups: readonly BaseRefSearchResult[][],
  limit: number
): BaseRefSearchResult[] {
  const seen = new Set<string>()
  const merged: BaseRefSearchResult[] = []
  const maxLength = Math.max(0, ...groups.map((group) => group.length))
  for (let index = 0; index < maxLength && merged.length < limit; index += 1) {
    for (const group of groups) {
      const entry = group[index]
      if (!entry || seen.has(entry.refName)) {
        continue
      }
      seen.add(entry.refName)
      merged.push(entry)
      if (merged.length >= limit) {
        break
      }
    }
  }
  return merged
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
export async function getDefaultRemote(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string> {
  const defaultRef = await getDefaultBaseRefAsync(path, options)
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
        gitExecOptions(path, options)
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
    const { stdout } = await gitExecFileAsync(['remote'], gitExecOptions(path, options))
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
    const remotes = await listRemoteNames(path)
    const tokens = getRefSearchTokens(normalizedQuery)
    if (tokens.length > 1) {
      // Why: ambiguous slash queries need both display-format matches
      // (`upstream/feat`) and local branch-name matches (`plan/docs`).
      // Parse and merge buckets before the final limit so neither side starves.
      const results = await Promise.all([
        runSearchBaseRefsGit(path, normalizedQuery, limit, {
          remoteNames: remotes,
          patternGroup: 'segmented'
        }),
        runSearchBaseRefsGit(path, normalizedQuery, limit, {
          remoteNames: remotes,
          patternGroup: 'branchRoot'
        })
      ])
      return mergeBaseRefSearchResultGroups(
        results.map((entry) => parseAndFilterSearchRefDetails(entry.stdout, limit, remotes)),
        limit
      )
    }

    const result = await runSearchBaseRefsGit(path, normalizedQuery, limit, {
      remoteNames: remotes
    })
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

async function listRemoteNames(path: string, options: LocalGitExecOptions = {}): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync(['remote'], gitExecOptions(path, options))
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

async function hasGitRefAsync(
  path: string,
  ref: string,
  options: LocalGitExecOptions = {}
): Promise<boolean> {
  try {
    await gitExecFileAsync(['rev-parse', '--verify', ref], gitExecOptions(path, options))
    return true
  } catch {
    return false
  }
}

export type BranchConflictKind = 'local' | 'remote'

export async function getBranchConflictKind(
  path: string,
  branchName: string,
  allowedBaseRef?: string,
  options: LocalGitExecOptions = {}
): Promise<BranchConflictKind | null> {
  if (await hasGitRefAsync(path, `refs/heads/${branchName}`, options)) {
    return 'local'
  }

  try {
    const remoteNames = (await listRemoteNames(path, options)).sort((a, b) => b.length - a.length)
    const { stdout } = await gitExecFileAsync(
      ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
      gitExecOptions(path, options)
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
