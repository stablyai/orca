/* eslint-disable max-lines -- Why: this file keeps git worktree create/remove behavior together so local cleanup and creation invariants stay in one place. */
import { stat } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import {
  branchHasNoUnmergedChangesOnAnyTarget,
  getBranchCleanupTargetRefs,
  refreshBranchCleanupTargetRefs
} from '../../shared/git-branch-cleanup'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree-base-ref'
import type {
  GitWorktreeInfo,
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion,
  RemoveWorktreeResult
} from '../../shared/types'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree-removal'
import { isSubmoduleWorktreeRemovalRefusal } from '../../shared/worktree-submodule-removal'
import { decodeGitCQuotedPath } from '../../shared/git-cquoted-path'
import { parseGitRevListAheadBehindCounts } from '../../shared/git-rev-list-output'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  hasUnsupportedRevParsePathFormatEcho,
  isUnsupportedRevParsePathFormatError,
  isUnsupportedWorktreeListZError
} from '../../shared/git-worktree-command-capabilities'
import { getLocalGitCapabilityCache } from './git-capability-state'
import { gitExecFileAsync, translateWslOutputPaths } from './runner'
import { resolveGitDir, runWithGitReadCacheInvalidation } from './status'
import { hasWorktreeBaseCommitRef } from './worktree-base-ref-probe'

export type AddWorktreeResult = {
  localBaseRefRefresh?: LocalBaseRefRefreshResult
  localBaseRefUpdateSuggestion?: LocalBaseRefUpdateSuggestion
}

type SparseWorktreeCreateError = Error & {
  cleanupFailed?: boolean
}

export type GitWorktreeExecOptions = {
  wslDistro?: string
  signal?: AbortSignal
  timeout?: number
}

type WorktreeRemovalPreflightOptions = GitWorktreeExecOptions & {
  ignoredUntrackedPaths?: readonly string[]
}

export type AddWorktreeOptions = GitWorktreeExecOptions & {
  checkoutExistingBranch?: boolean
  suggestLocalBaseRefUpdate?: boolean
  remoteTrackingBase?: {
    base: string
    branch: string
    ref: string
  }
}

export type RemoveWorktreeOptions = GitWorktreeExecOptions & {
  deleteBranch?: boolean
  forceBranchDelete?: boolean
  knownRemovedWorktree?: Pick<GitWorktreeInfo, 'branch' | 'head' | 'locked' | 'lockReason'>
}

type LocalBaseRefRefreshability =
  | {
      refreshable: true
      baseRef: string
      localBranch: string
      fullRef: string
      remoteTrackingRef: string
      localOid: string
      remoteOid: string
      behind: number
      ownerWorktreePath?: string
    }
  | {
      refreshable: false
      result: LocalBaseRefRefreshResult
    }

const SPARSE_CHECKOUT_DETECTION_CONCURRENCY = 8

const PRUNABLE_EXISTENCE_PROBE_CONCURRENCY = 8

// Why: bound `git worktree add` so a OneDrive cloud-placeholder stall fails fast (STA-1292); generous enough for a legit large checkout (#7225).
export const WORKTREE_ADD_TIMEOUT_MS = 180_000
export const WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS = 30_000

function gitExecOptions(
  cwd: string,
  options: GitWorktreeExecOptions = {}
): { cwd: string; wslDistro?: string; signal?: AbortSignal; timeout?: number } {
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {})
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function getErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const parts: string[] = []
    if ('message' in error && typeof error.message === 'string') {
      parts.push(error.message)
    }
    if ('stderr' in error && typeof error.stderr === 'string') {
      parts.push(error.stderr)
    }
    return parts.join('\n')
  }
  return String(error)
}

function isNotGitRepositoryError(error: unknown): boolean {
  return /not a git repository/i.test(getErrorText(error))
}

function isBranchCheckedOutInWorktreeError(error: unknown): boolean {
  return /cannot delete branch .*(?:used by worktree|checked out)|branch .*is checked out/i.test(
    getErrorText(error)
  )
}

function normalizeLocalBranchRef(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

function parseRemoteTrackingLocalBaseRef(
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase']
): { baseRef: string; localBranch: string; fullRef: string } | undefined {
  if (remoteTrackingBase?.ref === remoteTrackingRef) {
    return {
      baseRef: remoteTrackingBase.base,
      localBranch: remoteTrackingBase.branch,
      fullRef: `refs/heads/${remoteTrackingBase.branch}`
    }
  }

  const remoteRefPrefix = 'refs/remotes/'
  if (!remoteTrackingRef.startsWith(remoteRefPrefix)) {
    return undefined
  }

  // Why: only proven remote-tracking refs get refresh status; slash-containing local branches (release/2026) must not fake a "not refreshed" warning.
  const shortRemoteRef = remoteTrackingRef.slice(remoteRefPrefix.length)
  const slashIndex = shortRemoteRef.indexOf('/')
  if (slashIndex <= 0) {
    return undefined
  }

  const localBranch = shortRemoteRef.slice(slashIndex + 1)
  return {
    baseRef: baseBranch,
    localBranch,
    fullRef: `refs/heads/${localBranch}`
  }
}

function parseRevListDrift(output: string): { ahead: number; behind: number } | null {
  const counts = parseGitRevListAheadBehindCounts(output)
  return counts.status === 'ok' ? { ahead: counts.ahead, behind: counts.behind } : null
}

async function evaluateLocalBaseRefRefreshability(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {},
  shouldInspectOwner: (behind: number) => boolean = () => true
): Promise<LocalBaseRefRefreshability | undefined> {
  const parsed = parseRemoteTrackingLocalBaseRef(baseBranch, remoteTrackingRef, remoteTrackingBase)
  if (!parsed) {
    return undefined
  }

  const resultBase = { baseRef: parsed.baseRef, localBranch: parsed.localBranch }

  let drift: { ahead: number; behind: number }
  let localOid = ''
  let remoteOid = ''
  try {
    // Why: advisory and mutating paths must agree on "safe to fast-forward"; `rev-list A...B` proves no local-only commits and how far behind.
    const { stdout } = await gitExecFileAsync(
      ['rev-list', '--left-right', '--count', `${parsed.fullRef}...${remoteTrackingRef}`],
      gitExecOptions(repoPath, options)
    )
    const parsedDrift = parseRevListDrift(stdout)
    if (!parsedDrift || parsedDrift.ahead !== 0) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    if (!shouldInspectOwner(parsedDrift.behind)) {
      // Why: a current local ref yields no update suggestion, so the advisory path skips OID resolution and owner inspection.
      return undefined
    }
    const { stdout: localOidOutput } = await gitExecFileAsync(
      ['rev-parse', '--verify', `${parsed.fullRef}^{commit}`],
      gitExecOptions(repoPath, options)
    )
    localOid = localOidOutput.trim()
    if (!localOid) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    const { stdout: remoteOidOutput } = await gitExecFileAsync(
      ['rev-parse', '--verify', `${remoteTrackingRef}^{commit}`],
      gitExecOptions(repoPath, options)
    )
    remoteOid = remoteOidOutput.trim()
    if (!remoteOid) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    await gitExecFileAsync(
      ['merge-base', '--is-ancestor', localOid, remoteOid],
      gitExecOptions(repoPath, options)
    )
    drift = parsedDrift
  } catch {
    return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
  }

  try {
    // Why: if the local base branch is checked out, only update it when that owner worktree is clean.
    const { stdout: worktreeListOutput } = await gitExecFileAsync(
      ['worktree', 'list', '--porcelain'],
      gitExecOptions(repoPath, options)
    )
    const worktrees = parseWorktreeList(
      translateWslOutputPaths(worktreeListOutput, repoPath, options)
    )
    const ownerWorktree = worktrees.find((wt) => wt.branch === parsed.fullRef)

    if (ownerWorktree) {
      const { stdout: status } = await gitExecFileAsync(
        ['status', '--porcelain', '--untracked-files=no'],
        gitExecOptions(ownerWorktree.path, options)
      )
      if (status.trim()) {
        return {
          refreshable: false,
          result: {
            ...resultBase,
            status: 'skipped_dirty_worktree',
            ownerWorktreePath: ownerWorktree.path
          }
        }
      }
      return {
        refreshable: true,
        ...resultBase,
        fullRef: parsed.fullRef,
        remoteTrackingRef,
        localOid,
        remoteOid,
        behind: drift.behind,
        ownerWorktreePath: ownerWorktree.path
      }
    }

    // Why: localBranch isn't checked out anywhere, so a bare-ref fast-forward is safe; omitting ownerWorktreePath signals the mutating path to take it.
    return {
      refreshable: true,
      ...resultBase,
      fullRef: parsed.fullRef,
      remoteTrackingRef,
      localOid,
      remoteOid,
      behind: drift.behind
    }
  } catch {
    return { refreshable: false, result: { ...resultBase, status: 'skipped_error' } }
  }
}

async function getLocalBaseRefUpdateSuggestionForWorktreeCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefUpdateSuggestion | undefined> {
  const evaluation = await evaluateLocalBaseRefRefreshability(
    repoPath,
    baseBranch,
    remoteTrackingRef,
    remoteTrackingBase,
    options,
    (behind) => behind > 0
  )
  if (!evaluation?.refreshable || evaluation.behind <= 0) {
    return undefined
  }
  return {
    baseRef: evaluation.baseRef,
    localBranch: evaluation.localBranch,
    behind: evaluation.behind
  }
}

async function persistWorktreeCreationBase(
  worktreePath: string,
  branch: string,
  effectiveBase: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  const configKey = `branch.${branch}.base`
  try {
    await gitExecFileAsync(['config', '--local', '--replace-all', configKey, effectiveBase], {
      ...gitExecOptions(worktreePath, options)
    })
  } catch (error) {
    console.warn(`addWorktree: failed to set ${configKey} for ${worktreePath}`, error)
    try {
      // Why: reused branch names may carry stale base metadata; if replacement fails, unset it so consumers don't trust stale lineage.
      await gitExecFileAsync(['config', '--local', '--unset-all', configKey], {
        ...gitExecOptions(worktreePath, options)
      })
    } catch (unsetError) {
      console.warn(
        `addWorktree: failed to unset stale ${configKey} for ${worktreePath}`,
        unsetError
      )
    }
  }
}

async function unsetWorktreeCreationBase(
  worktreePath: string,
  branch: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  try {
    await gitExecFileAsync(['config', '--local', '--unset-all', `branch.${branch}.base`], {
      ...gitExecOptions(worktreePath, options)
    })
  } catch {
    // Best-effort cleanup; leave the original sparse-setup error as the actionable failure.
  }
}

function areWorktreePathsEqual(
  leftPath: string,
  rightPath: string,
  platform = process.platform
): boolean {
  if (platform === 'win32' || looksLikeWindowsPath(leftPath) || looksLikeWindowsPath(rightPath)) {
    return (
      win32.normalize(win32.resolve(leftPath)).toLowerCase() ===
      win32.normalize(win32.resolve(rightPath)).toLowerCase()
    )
  }
  return posix.normalize(posix.resolve(leftPath)) === posix.normalize(posix.resolve(rightPath))
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

function resolveRevParsePath(repoPath: string, value: string): string {
  if (posix.isAbsolute(value) || win32.isAbsolute(value)) {
    return value
  }
  // Old git ignores `--path-format=absolute`, so resolve a relative toplevel/git-dir against the scanned repo path.
  return looksLikeWindowsPath(repoPath)
    ? win32.resolve(repoPath, value)
    : posix.resolve(repoPath, value)
}

type RepoLocation = { topLevel: string; commonDir: string }

function parseRepoLocation(repoPath: string, output: string): RepoLocation | undefined {
  // Old git echoes the unrecognized `--path-format` flag and exits 0, so drop `-`-prefixed lines and
  // read the last two path lines (toplevel, git-common-dir); strip only trailing CR — paths may have edge spaces.
  const lines = output
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0 && !line.startsWith('-'))
  if (lines.length < 2) {
    return undefined
  }
  const [topLevel, commonDir] = lines.slice(-2)
  return {
    topLevel: resolveRevParsePath(repoPath, topLevel),
    commonDir: resolveRevParsePath(repoPath, commonDir)
  }
}

async function readRepoLocation(
  repoPath: string,
  resolveBasePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<RepoLocation | undefined> {
  const capabilities = getLocalGitCapabilityCache({
    cwd: repoPath,
    wslDistro: options.wslDistro
  })
  try {
    return await capabilities.runWithFallback(
      'rev-parse-path-format',
      async () => {
        const { stdout } = await gitExecFileAsync(
          ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
          gitExecOptions(repoPath, options)
        )
        if (hasUnsupportedRevParsePathFormatEcho(stdout)) {
          // Why: some old Git echoes the unknown option and exits zero; remember that compat signal even though parsing recovers.
          capabilities.rememberUnsupported('rev-parse-path-format')
        }
        return parseRepoLocation(resolveBasePath, stdout)
      },
      async () => {
        const { stdout } = await gitExecFileAsync(
          ['rev-parse', '--show-toplevel', '--git-common-dir'],
          gitExecOptions(repoPath, options)
        )
        return parseRepoLocation(resolveBasePath, stdout)
      },
      isUnsupportedRevParsePathFormatError
    )
  } catch {
    return undefined
  }
}

async function normalizeMainWorktreePath(
  repoPath: string,
  worktrees: GitWorktreeInfo[],
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const mainIndex = worktrees.findIndex((worktree) => worktree.isMainWorktree)
  const mainWorktree = worktrees[mainIndex]
  // Why: under WSL, porcelain/rev-parse paths are Linux but repoPath is UNC; compare in Git-output
  // space so the early-return matches and we skip a needless rev-parse per poll (runner still gets repoPath).
  const wslRepo = parseWslUncPath(repoPath)
  const comparablePath = wslRepo ? wslRepo.linuxPath : repoPath
  if (!mainWorktree || areWorktreePathsEqual(mainWorktree.path, comparablePath)) {
    return worktrees
  }

  const location = await readRepoLocation(repoPath, comparablePath, options)
  if (!location) {
    return worktrees
  }

  // Why: only a separate-git-dir/submodule main worktree reports git-common-dir as its path; gate on
  // that equality so we don't overwrite a linked worktree's real working root with its own toplevel.
  if (!areWorktreePathsEqual(mainWorktree.path, location.commonDir)) {
    return worktrees
  }

  const normalized = [...worktrees]
  normalized[mainIndex] = { ...mainWorktree, path: location.topLevel }
  return normalized
}

/**
 * Parse the porcelain output of `git worktree list --porcelain`.
 */
export function parseWorktreeList(
  output: string,
  options: { nulDelimited?: boolean } = {}
): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = []
  const blocks = options.nulDelimited ? splitNulWorktreeList(output) : splitLineWorktreeList(output)

  for (const lines of blocks) {
    if (lines.length === 0) {
      continue
    }

    let path = ''
    let head = ''
    let branch = ''
    let isBare = false
    let isSparse = false
    let locked = false
    let lockReason = ''
    let prunable = false
    let prunableReason = ''

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length)
      } else if (line === 'bare') {
        isBare = true
      } else if (line === 'sparse') {
        isSparse = true
      } else if (line === 'locked' || line.startsWith('locked ')) {
        locked = true
        const rawReason = line.slice('locked'.length).trim()
        lockReason = options.nulDelimited ? rawReason : decodeGitCQuotedPath(rawReason)
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        // Why: Git ≥2.36 flags registrations whose directory is gone; ignoring it shows the stale worktree as live (#8389).
        prunable = true
        const rawReason = line.slice('prunable'.length).trim()
        prunableReason = options.nulDelimited ? rawReason : decodeGitCQuotedPath(rawReason)
      }
    }

    if (path) {
      // `git worktree list` always emits the main working tree first.
      worktrees.push({
        path,
        head,
        branch,
        isBare,
        ...(isSparse ? { isSparse } : {}),
        ...(locked ? { locked: true } : {}),
        ...(lockReason ? { lockReason } : {}),
        ...(prunable ? { prunable: true } : {}),
        ...(prunableReason ? { prunableReason } : {}),
        isMainWorktree: worktrees.length === 0
      })
    }
  }

  return worktrees
}

function splitLineWorktreeList(output: string): string[][] {
  return output
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim().split(/\r?\n/))
}

function splitNulWorktreeList(output: string): string[][] {
  if (!output.includes('\0')) {
    return splitLineWorktreeList(output)
  }

  const blocks: string[][] = []
  let currentBlock: string[] = []

  for (const field of output.split('\0')) {
    if (field) {
      currentBlock.push(field)
      continue
    }
    if (currentBlock.length > 0) {
      blocks.push(currentBlock)
      currentBlock = []
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock)
  }

  return blocks
}

async function readWorktreeList(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const capabilities = getLocalGitCapabilityCache({
    cwd: repoPath,
    wslDistro: options.wslDistro
  })
  return capabilities.runWithFallback(
    'worktree-list-z',
    async () => {
      const { stdout } = await gitExecFileAsync(['worktree', 'list', '--porcelain', '-z'], {
        cwd: repoPath,
        ...options
      })
      return normalizeMainWorktreePath(
        repoPath,
        parseWorktreeList(stdout, { nulDelimited: true }),
        options
      )
    },
    async () => {
      // Why: `-z` preserves worktree paths with newlines but Git <2.36 rejects it; fall back to the line parser.
      const { stdout } = await gitExecFileAsync(['worktree', 'list', '--porcelain'], {
        cwd: repoPath,
        ...options
      })
      const normalized = await normalizeMainWorktreePath(
        repoPath,
        parseWorktreeList(stdout),
        options
      )
      // Why: Git <2.31 emits no `prunable`, so probe each linked path for existence instead of trusting
      // stale registrations; a harmless backstop on 2.31–2.35 where parseWorktreeList already set it (#8389).
      return annotatePrunableByExistence(normalized, repoPath, options)
    },
    isUnsupportedWorktreeListZError
  )
}

async function annotatePrunableByExistence(
  worktrees: GitWorktreeInfo[],
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const annotated = [...worktrees]
  let nextIndex = 0

  async function probeNext(): Promise<void> {
    while (nextIndex < worktrees.length) {
      const index = nextIndex
      nextIndex += 1
      const worktree = worktrees[index]
      // Git only prunes linked worktrees, never locked ones (a lock shields a missing dir; `locked`
      // parses only on Git >=2.31). A missing main worktree is handled by the repo-level ENOENT paths.
      if (
        !worktree ||
        worktree.isMainWorktree ||
        worktree.isBare ||
        worktree.locked ||
        worktree.prunable
      ) {
        continue
      }
      try {
        await stat(translateWorktreePath(worktree.path, repoPath, options))
      } catch (err) {
        if (getErrorCode(err) === 'ENOENT') {
          annotated[index] = { ...worktree, prunable: true }
        }
      }
    }
  }

  const workerCount = Math.min(PRUNABLE_EXISTENCE_PROBE_CONCURRENCY, worktrees.length)
  await Promise.all(Array.from({ length: workerCount }, () => probeNext()))
  return annotated
}

async function readTranslatedWorktreeGraph(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  return (await readWorktreeList(repoPath, options)).map((worktree) => {
    const translatedPath = translateWorktreePath(worktree.path, repoPath, options)
    return translatedPath === worktree.path ? worktree : { ...worktree, path: translatedPath }
  })
}

export async function listWorktreeGraph(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  try {
    return await readTranslatedWorktreeGraph(repoPath, options)
  } catch (err) {
    if (getErrorCode(err) === 'ENOENT') {
      try {
        await stat(repoPath)
      } catch (statErr) {
        if (getErrorCode(statErr) === 'ENOENT') {
          console.warn(`[git/worktree] repo path missing; skipping worktree list: ${repoPath}`)
          return []
        }
      }
    }
    if (isNotGitRepositoryError(err)) {
      return []
    }
    console.warn(`[git/worktree] listWorktreeGraph failed for ${repoPath}:`, err)
    return []
  }
}

// Why: cold start triggers many concurrent `git worktree list` spawns per repo (expensive on Windows, #7225); share the in-flight promise to collapse duplicates.
const inFlightWorktreeScans = new Map<string, Promise<GitWorktreeInfo[]>>()

// Why: a listing after a mutation must not join a scan that predates it; bumping the generation on mutation retires older in-flight scans from sharing.
const worktreeScanGenerations = new Map<string, number>()

function hasInFlightWorktreeScanForRepo(repoPath: string): boolean {
  const keyPrefix = `${repoPath}\0`
  for (const key of inFlightWorktreeScans.keys()) {
    if (key.startsWith(keyPrefix)) {
      return true
    }
  }
  return false
}

function bumpWorktreeScanGeneration(repoPath: string): void {
  // Why: generations only prevent joining a pre-mutation scan; with no active scan, keeping the repo path just leaks completed mutation keys.
  if (!hasInFlightWorktreeScanForRepo(repoPath)) {
    return
  }
  worktreeScanGenerations.set(repoPath, (worktreeScanGenerations.get(repoPath) ?? 0) + 1)
}

function pruneWorktreeScanGeneration(repoPath: string): void {
  // Why: keep ordinary scan settlement O(1); only repos invalidated during an active scan need the cross-generation check.
  if (!worktreeScanGenerations.has(repoPath)) {
    return
  }
  if (!hasInFlightWorktreeScanForRepo(repoPath)) {
    worktreeScanGenerations.delete(repoPath)
  }
}

export function _getWorktreeScanCacheSizesForTests(): { inFlight: number; generations: number } {
  return {
    inFlight: inFlightWorktreeScans.size,
    generations: worktreeScanGenerations.size
  }
}

export function _resetWorktreeScanCacheForTests(): void {
  inFlightWorktreeScans.clear()
  worktreeScanGenerations.clear()
}

/**
 * List all worktrees for a git repo at the given path. Concurrent calls for
 * the same repo share one scan (unless the caller passes an AbortSignal,
 * which must only cancel its own scan).
 */
export function listWorktrees(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  if (options.signal) {
    return listWorktreesUnshared(repoPath, options)
  }
  const generation = worktreeScanGenerations.get(repoPath) ?? 0
  const key = `${repoPath}\0${options.wslDistro ?? ''}\0${generation}`
  const inFlight = inFlightWorktreeScans.get(key)
  if (inFlight) {
    return inFlight
  }
  const scan = listWorktreesUnshared(repoPath, options).finally(() => {
    if (inFlightWorktreeScans.get(key) === scan) {
      inFlightWorktreeScans.delete(key)
    }
    pruneWorktreeScanGeneration(repoPath)
  })
  inFlightWorktreeScans.set(key, scan)
  return scan
}

async function listWorktreesUnshared(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  try {
    const worktrees = await readTranslatedWorktreeGraph(repoPath, options)
    return annotateSparseCheckoutStatus(worktrees)
  } catch (err) {
    if (getErrorCode(err) === 'ENOENT') {
      try {
        await stat(repoPath)
      } catch (statErr) {
        if (getErrorCode(statErr) === 'ENOENT') {
          console.warn(`[git/worktree] repo path missing; skipping worktree list: ${repoPath}`)
          return []
        }
      }
    }
    if (isNotGitRepositoryError(err)) {
      return []
    }
    // Why: don't swallow git-compat/repo-state failures — else they resurface as opaque "created but not found in listing" errors.
    console.warn(`[git/worktree] listWorktrees failed for ${repoPath}:`, err)
    return []
  }
}

export async function listWorktreesStrict(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const worktrees = (await readWorktreeList(repoPath, options)).map((worktree) => {
    const translatedPath = translateWorktreePath(worktree.path, repoPath, options)
    return translatedPath === worktree.path ? worktree : { ...worktree, path: translatedPath }
  })
  return annotateSparseCheckoutStatus(worktrees)
}

async function annotateSparseCheckoutStatus(
  worktrees: GitWorktreeInfo[]
): Promise<GitWorktreeInfo[]> {
  const annotated = [...worktrees]
  let nextIndex = 0

  async function detectNext(): Promise<void> {
    while (nextIndex < worktrees.length) {
      const index = nextIndex
      nextIndex += 1
      const worktree = worktrees[index]
      if (!worktree || worktree.isBare || worktree.isSparse) {
        continue
      }
      const isSparse = await detectSparseCheckout(worktree.path)
      if (isSparse) {
        annotated[index] = { ...worktree, isSparse }
      }
    }
  }

  // Why: cap concurrency so status-poll refreshes don't fan out many sparse-checkout filesystem probes at once.
  const workerCount = Math.min(SPARSE_CHECKOUT_DETECTION_CONCURRENCY, worktrees.length)
  await Promise.all(Array.from({ length: workerCount }, () => detectNext()))
  return annotated
}

async function refreshLocalBaseRefForWorktreeCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefRefreshResult | undefined> {
  const evaluation = await evaluateLocalBaseRefRefreshability(
    repoPath,
    baseBranch,
    remoteTrackingRef,
    remoteTrackingBase,
    options
  )
  if (!evaluation) {
    return undefined
  }
  if (!evaluation.refreshable) {
    return evaluation.result
  }

  const resultBase = { baseRef: evaluation.baseRef, localBranch: evaluation.localBranch }
  try {
    if (evaluation.ownerWorktreePath) {
      const { stdout: worktreeListOutput } = await gitExecFileAsync(
        ['worktree', 'list', '--porcelain'],
        gitExecOptions(repoPath, options)
      )
      const worktrees = parseWorktreeList(
        translateWslOutputPaths(worktreeListOutput, repoPath, options)
      )
      const currentOwner = worktrees.find((wt) => wt.branch === evaluation.fullRef)
      if (!currentOwner || currentOwner.path !== evaluation.ownerWorktreePath) {
        return { ...resultBase, status: 'skipped_error' }
      }
      const { stdout: status } = await gitExecFileAsync(
        ['status', '--porcelain', '--untracked-files=no'],
        gitExecOptions(currentOwner.path, options)
      )
      if (status.trim()) {
        return {
          ...resultBase,
          status: 'skipped_dirty_worktree',
          ownerWorktreePath: currentOwner.path
        }
      }
      await gitExecFileAsync(
        ['reset', '--hard', evaluation.remoteOid],
        gitExecOptions(currentOwner.path, options)
      )
      return { ...resultBase, status: 'updated', ownerWorktreePath: currentOwner.path }
    }

    // Why: no owner worktree — fast-forward the bare ref; the expected-old-OID form is a no-op-safe CAS if the ref moved since evaluation.
    await gitExecFileAsync(
      ['update-ref', evaluation.fullRef, evaluation.remoteOid, evaluation.localOid],
      gitExecOptions(repoPath, options)
    )
    return { ...resultBase, status: 'updated' }
  } catch {
    // update-ref/reset can fail on locked refs or odd worktree states; worktree creation should still proceed.
    return { ...resultBase, status: 'skipped_error' }
  }
}

/**
 * Create a new worktree.
 * @param repoPath - Path to the main repo (or bare repo)
 * @param worktreePath - Absolute path where the worktree will be created
 * @param branch - Branch name for the new worktree
 * @param baseBranch - Optional base branch to create from (defaults to HEAD)
 * @remarks Side effects (best-effort, warn-only): passes `--no-track`, writes
 * `branch.<branch>.base` for new-branch worktrees with a base ref, and may
 * write `push.autoSetupRemote=true` to the repo's shared config.
 */
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch?: string,
  refreshLocalBaseRef = false,
  noCheckout = false,
  options: AddWorktreeOptions = {}
): Promise<AddWorktreeResult> {
  try {
    return await runWithGitReadCacheInvalidation(() =>
      performAddWorktree(
        repoPath,
        worktreePath,
        branch,
        baseBranch,
        refreshLocalBaseRef,
        noCheckout,
        options
      )
    )
  } finally {
    bumpWorktreeScanGeneration(repoPath)
  }
}

async function performAddWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch?: string,
  refreshLocalBaseRef = false,
  noCheckout = false,
  options: AddWorktreeOptions = {}
): Promise<AddWorktreeResult> {
  let localBaseRefRefresh: LocalBaseRefRefreshResult | undefined
  let localBaseRefUpdateSuggestion: LocalBaseRefUpdateSuggestion | undefined
  const args = ['worktree', 'add']
  let effectiveBase: string | undefined
  if (noCheckout) {
    args.push('--no-checkout')
  }
  if (options.checkoutExistingBranch) {
    // Why: -b would create a new branch instead of checking out the selected one.
    args.push(worktreePath, branch)
  } else {
    // Why: --no-track avoids inheriting the base's upstream so `git status` won't misreport "behind by N" pre-publish; first push sets it (see push.autoSetupRemote below).
    args.push('--no-track', '-b', branch, worktreePath)
    if (baseBranch) {
      effectiveBase = await resolveWorktreeAddBaseRef(baseBranch, (qualifiedRef) =>
        hasWorktreeBaseCommitRef(repoPath, qualifiedRef, options)
      )
      // Why: resolve the creation base first to distinguish remote-tracking refs from slash-containing local branches (mutation gated behind the explicit setting).
      if (refreshLocalBaseRef) {
        localBaseRefRefresh = await refreshLocalBaseRefForWorktreeCreate(
          repoPath,
          baseBranch,
          effectiveBase,
          options.remoteTrackingBase,
          options
        )
      } else if (options.suggestLocalBaseRefUpdate) {
        localBaseRefUpdateSuggestion = await getLocalBaseRefUpdateSuggestionForWorktreeCreate(
          repoPath,
          baseBranch,
          effectiveBase,
          options.remoteTrackingBase,
          options
        )
      }
      args.push(effectiveBase)
    }
  }
  await gitExecFileAsync(args, {
    ...gitExecOptions(repoPath, options),
    // Why: bound the checkout so a OneDrive cloud-placeholder stall (STA-1292) fails fast instead of hanging.
    timeout: WORKTREE_ADD_TIMEOUT_MS
  })

  if (options.checkoutExistingBranch) {
    return localBaseRefRefresh ? { localBaseRefRefresh } : {}
  }

  if (effectiveBase) {
    await persistWorktreeCreationBase(worktreePath, branch, effectiveBase, options)
  }

  // SSH parity: relay's addWorktreeOp (src/relay/git-handler-worktree-ops.ts) mirrors this — change both in lockstep.
  // Why: --no-track leaves no upstream until first push; push.autoSetupRemote=true lets a plain
  // `git push` create+set origin/<branch> (git >=2.37; older clients ignore it). `--local` on a
  // linked worktree writes the shared common-dir config (whole repo) — intentional and idempotent,
  // so it's warn-only and not rolled back on failure.
  try {
    // Why: `--get` (not `--local --get`) so a value at any scope counts as "user already chose" and isn't overwritten.
    let alreadySet = false
    try {
      await gitExecFileAsync(['config', '--get', 'push.autoSetupRemote'], {
        ...gitExecOptions(worktreePath, options)
      })
      alreadySet = true
    } catch (readError) {
      // Why: `git config --get` exits 1 only when unset at every scope; any other code is a real read failure — rethrow rather than overwrite the user's value.
      const code = (readError as { code?: unknown })?.code
      if (code !== 1) {
        throw readError
      }
    }
    if (!alreadySet) {
      await gitExecFileAsync(['config', '--local', 'push.autoSetupRemote', 'true'], {
        ...gitExecOptions(worktreePath, options)
      })
    }
  } catch (error) {
    console.warn(`addWorktree: failed to set push.autoSetupRemote for ${worktreePath}`, error)
  }
  return {
    ...(localBaseRefRefresh ? { localBaseRefRefresh } : {}),
    ...(localBaseRefUpdateSuggestion ? { localBaseRefUpdateSuggestion } : {})
  }
}

export async function addSparseWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  directories: string[],
  baseBranch?: string,
  refreshLocalBaseRef = false,
  options: AddWorktreeOptions = {}
): Promise<AddWorktreeResult> {
  let created = false
  let addResult: AddWorktreeResult = {}
  try {
    addResult = await addWorktree(
      repoPath,
      worktreePath,
      branch,
      baseBranch,
      refreshLocalBaseRef,
      true,
      options
    )
    created = true
    await gitExecFileAsync(
      ['sparse-checkout', 'init', '--cone'],
      gitExecOptions(worktreePath, options)
    )
    await gitExecFileAsync(
      ['sparse-checkout', 'set', '--', ...directories],
      gitExecOptions(worktreePath, options)
    )
    await gitExecFileAsync(['checkout', branch], gitExecOptions(worktreePath, options))
    return addResult
  } catch (error) {
    const wrapped: SparseWorktreeCreateError =
      error instanceof Error ? (error as SparseWorktreeCreateError) : new Error(String(error))
    if (created) {
      if (!options.checkoutExistingBranch) {
        await unsetWorktreeCreationBase(worktreePath, branch, options)
      }
      try {
        await removeWorktree(repoPath, worktreePath, true, {
          deleteBranch: !options.checkoutExistingBranch,
          // Why: failed-creation rollback — the fresh branch has no user commits, so force-delete rather than orphan it.
          forceBranchDelete: !options.checkoutExistingBranch,
          ...(options.wslDistro ? { wslDistro: options.wslDistro } : {})
        })
      } catch {
        wrapped.cleanupFailed = true
        // Why: surface that manual cleanup may be needed, else a half-created worktree lingers silently on disk.
        wrapped.message = `${wrapped.message} (cleanup also failed — the partially created worktree at "${worktreePath}" may need manual removal)`
      }
    }
    throw wrapped
  }
}

/**
 * Move a worktree with `git worktree move` (not `fs.rename`, which corrupts the
 * `.git` file and the `.git/worktrees/<name>/gitdir` back-pointer). Local-only,
 * so there is no relay parity handler. Caller owns migrating Orca's
 * path-derived worktree identity and pre-checks that the destination is free.
 */
export async function moveWorktree(
  repoPath: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  try {
    await runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync(['worktree', 'move', oldPath, newPath], { cwd: repoPath })
    )
  } finally {
    bumpWorktreeScanGeneration(repoPath)
  }
}

/**
 * Remove a worktree.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
  // forceBranchDelete: for failed-creation rollback (fresh branch, no user work); user deletes leave it false so unmerged commits survive.
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  try {
    return await runWithGitReadCacheInvalidation(() =>
      performRemoveWorktree(repoPath, worktreePath, force, options)
    )
  } finally {
    bumpWorktreeScanGeneration(repoPath)
  }
}

async function performRemoveWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  const removedWorktree =
    options.knownRemovedWorktree ??
    (await listWorktrees(repoPath, options)).find((worktree) =>
      areWorktreePathsEqual(worktree.path, worktreePath)
    )
  const branchName = normalizeLocalBranchRef(removedWorktree?.branch ?? '')
  const branchHead = removedWorktree?.head ?? ''

  // Why: callers outside the IPC/runtime preflight must not bypass Git's lock contract or rely on localized stderr after side effects.
  assertWorktreeUnlockedForRemoval(removedWorktree)

  const args = ['worktree', 'remove']
  if (force) {
    args.push('--force')
  }
  args.push(worktreePath)
  try {
    await gitExecFileAsync(args, gitExecOptions(repoPath, options))
  } catch (error) {
    if (force || !isSubmoduleWorktreeRemovalRefusal(error)) {
      throw error
    }
    // Why: Git refuses non-force removal of a worktree with an initialised submodule even when clean; re-prove cleanliness, then --force.
    await assertWorktreeCleanForRemoval(worktreePath, false, options)
    await gitExecFileAsync(
      ['worktree', 'remove', '--force', worktreePath],
      gitExecOptions(repoPath, options)
    )
  }

  if (!branchName) {
    return {}
  }
  if (options.deleteBranch === false) {
    return {}
  }

  try {
    // Why: also drop the now-orphaned branch so delete-worktree leaves none; `-d` (not `-D`) preserves
    // unmerged work, and forceBranchDelete opts into `-D` for failed-creation rollback.
    const branchDeleteResult = await deleteLocalBranchAfterWorktreeRemoval(
      repoPath,
      branchName,
      options.forceBranchDelete === true,
      options
    )
    if (branchDeleteResult === 'checked-out') {
      return {}
    }
    return {}
  } catch (error) {
    if (!options.forceBranchDelete && branchHead) {
      try {
        if (
          await deleteAlreadyMergedBranchAfterSafeDeleteFailure(
            repoPath,
            branchName,
            branchHead,
            options
          )
        ) {
          return {}
        }
      } catch (alreadyMergedDeleteError) {
        // Why: worktree is already gone; a raced branch cleanup should degrade to preserved-branch recovery, not fail delete.
        console.warn(
          `[git] Failed to delete already-merged local branch "${branchName}" after removing worktree`,
          alreadyMergedDeleteError
        )
      }
    }
    // Keep an unmerged/unpublished branch: deleting a worktree must never silently discard commits.
    console.warn(
      `[git] Preserved local branch "${branchName}" after removing worktree (not fully merged)`,
      error
    )
    return { preservedBranch: { branchName, ...(branchHead ? { head: branchHead } : {}) } }
  }
}

async function deleteLocalBranchAfterWorktreeRemoval(
  repoPath: string,
  branchName: string,
  forceBranchDelete: boolean,
  options: GitWorktreeExecOptions = {}
): Promise<'deleted' | 'checked-out'> {
  const deleteFlag = forceBranchDelete ? '-D' : '-d'
  try {
    await gitExecFileAsync(
      ['branch', deleteFlag, '--', branchName],
      gitExecOptions(repoPath, options)
    )
    return 'deleted'
  } catch (error) {
    if (!isBranchCheckedOutInWorktreeError(error)) {
      throw error
    }
  }

  try {
    // Why: only pay for `worktree prune` when a stale admin record may be blocking `branch -d`.
    await gitExecFileAsync(['worktree', 'prune'], gitExecOptions(repoPath, options))
  } catch (error) {
    console.warn(`[git] Failed to prune worktrees before deleting branch "${branchName}"`, error)
    return 'checked-out'
  }

  try {
    await gitExecFileAsync(
      ['branch', deleteFlag, '--', branchName],
      gitExecOptions(repoPath, options)
    )
    return 'deleted'
  } catch (error) {
    if (isBranchCheckedOutInWorktreeError(error)) {
      return 'checked-out'
    }
    throw error
  }
}

async function deleteAlreadyMergedBranchAfterSafeDeleteFailure(
  repoPath: string,
  branchName: string,
  branchHead: string,
  options: GitWorktreeExecOptions = {}
): Promise<boolean> {
  const runGit = (args: string[], execOptions?: { stdin?: string }) =>
    gitExecFileAsync(args, {
      ...gitExecOptions(repoPath, options),
      ...(execOptions?.stdin !== undefined ? { stdin: execOptions.stdin } : {})
    })
  const targetRefs = await getBranchCleanupTargetRefs(runGit, branchName)
  await refreshBranchCleanupTargetRefs(runGit, targetRefs)
  // Why: squash merges rewrite commit IDs, so `branch -d` rejects already-merged branches; delete only when Git proves no unmerged tree changes.
  if (
    !(await branchHasNoUnmergedChangesOnAnyTarget(
      runGit,
      branchName,
      targetRefs,
      getLocalGitCapabilityCache({ cwd: repoPath, wslDistro: options.wslDistro })
    ))
  ) {
    return false
  }
  await forceDeleteLocalBranch(repoPath, branchName, branchHead, (args, cwd) =>
    gitExecFileAsync(args, gitExecOptions(cwd, options))
  )
  return true
}

export async function forceDeleteLocalBranch(
  repoPath: string,
  branchName: string,
  expectedHead: string,
  runGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }> = (
    args,
    cwd
  ) => gitExecFileAsync(args, { cwd })
): Promise<void> {
  if (!branchName || branchName.includes('\0')) {
    throw new Error('Invalid branch name')
  }
  if (!expectedHead) {
    throw new Error(
      `Cannot force-delete local branch "${branchName}" without the commit Git preserved.`
    )
  }
  if (await isLocalBranchCheckedOut(repoPath, branchName, runGit)) {
    throw new Error(`Local branch "${branchName}" is checked out in another worktree.`)
  }
  // Why: stale toast actions must not delete a branch that moved; `update-ref -d` deletes only if the ref still == expectedHead.
  try {
    await runGit(['update-ref', '-d', `refs/heads/${branchName}`, expectedHead], repoPath)
  } catch {
    throw new Error(
      `Local branch "${branchName}" changed after the workspace was deleted. Review it before deleting it.`
    )
  }
  if (await isLocalBranchCheckedOut(repoPath, branchName, runGit)) {
    try {
      await runGit(['update-ref', `refs/heads/${branchName}`, expectedHead, ''], repoPath)
    } catch (restoreError) {
      console.warn(
        `[git] Failed to restore local branch "${branchName}" after concurrent checkout`,
        restoreError
      )
    }
    throw new Error(`Local branch "${branchName}" is checked out in another worktree.`)
  }
  try {
    await runGit(['config', '--remove-section', `branch.${branchName}`], repoPath)
  } catch {
    // Best-effort parity with `git branch -D`; stale config is harmless.
  }
}

async function isLocalBranchCheckedOut(
  repoPath: string,
  branchName: string,
  runGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>
): Promise<boolean> {
  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], repoPath)
  return parseWorktreeList(stdout).some(
    (worktree) => normalizeLocalBranchRef(worktree.branch) === branchName
  )
}

/**
 * Assert a worktree is clean enough for non-force removal.
 */
export async function assertWorktreeCleanForRemoval(
  worktreePath: string,
  force = false,
  options: WorktreeRemovalPreflightOptions = {}
): Promise<void> {
  if (force) {
    return
  }

  const { ignoredUntrackedPaths = [], ...gitOptions } = options
  const useNullTerminatedStatus = ignoredUntrackedPaths.length > 0
  const { stdout } = await gitExecFileAsync(
    ['status', '--porcelain', ...(useNullTerminatedStatus ? ['-z'] : []), '--untracked-files=all'],
    {
      ...gitExecOptions(worktreePath, gitOptions),
      timeout: gitOptions.timeout ?? WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS
    }
  )
  if (
    useNullTerminatedStatus
      ? hasOnlyIgnoredUntrackedStatus(stdout, ignoredUntrackedPaths)
      : !stdout.trim()
  ) {
    return
  }

  const error = new Error('Worktree has uncommitted or untracked changes.')
  ;(error as Error & { stdout?: string }).stdout = stdout
  throw error
}

function hasOnlyIgnoredUntrackedStatus(
  status: string,
  ignoredUntrackedPaths: readonly string[]
): boolean {
  const ignored = new Set(
    ignoredUntrackedPaths
      .map((entry) =>
        entry
          .trim()
          .replace(/^[\\/]+/, '')
          .replace(/\\/g, '/')
      )
      .filter((entry) => entry && !entry.split('/').includes('..'))
  )
  return status
    .split('\0')
    .filter(Boolean)
    .every((entry) => entry.startsWith('?? ') && ignored.has(entry.slice(3).replace(/\\/g, '/')))
}

function translateWorktreePath(
  worktreePath: string,
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): string {
  const prefix = 'worktree '
  const translated = translateWslOutputPaths(`${prefix}${worktreePath}`, repoPath, options)
  return translated.startsWith(prefix) ? translated.slice(prefix.length) : worktreePath
}

async function detectSparseCheckout(worktreePath: string): Promise<boolean> {
  // Why: fs.stat the per-worktree gitdir's sparse-checkout config instead of a per-poll `git sparse-checkout list` subprocess that regressed responsiveness (PR #1290);
  // the file's presence is the per-worktree signal because core.sparseCheckout is shared across all worktrees.
  try {
    const gitDir = await resolveGitDir(worktreePath)
    const stats = await stat(join(gitDir, 'info', 'sparse-checkout'))
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}
