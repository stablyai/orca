/* eslint-disable max-lines -- Why: this file keeps git worktree create/remove behavior together so local cleanup and creation invariants stay in one place. */
import { stat } from 'fs/promises'
import { join, posix, win32 } from 'path'
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
import { gitExecFileAsync, translateWslOutputPaths } from './runner'
import { resolveGitDir } from './status'
import { hasWorktreeBaseCommitRef } from './worktree-base-ref-probe'

export type AddWorktreeResult = {
  localBaseRefRefresh?: LocalBaseRefRefreshResult
  localBaseRefUpdateSuggestion?: LocalBaseRefUpdateSuggestion
}

type SparseWorktreeCreateError = Error & {
  cleanupFailed?: boolean
}

type AddWorktreeOptions = {
  checkoutExistingBranch?: boolean
  suggestLocalBaseRefUpdate?: boolean
  remoteTrackingBase?: {
    base: string
    branch: string
    ref: string
  }
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

function isUnsupportedWorktreeListZError(error: unknown): boolean {
  return /(?:unknown|invalid) (?:switch|option).*`?-z'?|(?:unknown|invalid) (?:switch|option).*`?z'?/i.test(
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

  // Why: Only refs proven to be remote-tracking refs get refresh status.
  // Local branches can contain slashes (e.g. release/2026) and must not
  // produce a fake "Local 2026 was not refreshed" warning.
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
  const [aheadStr, behindStr] = output.trim().split(/\s+/)
  const ahead = Number(aheadStr)
  const behind = Number(behindStr)
  if (!Number.isFinite(ahead) || !Number.isFinite(behind) || ahead < 0 || behind < 0) {
    return null
  }
  return { ahead, behind }
}

async function evaluateLocalBaseRefRefreshability(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase']
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
    // Why: advisory and mutating paths must agree on "safe to fast-forward".
    // `rev-list A...B` proves the local branch exists, has no local-only
    // commits, and tells the toast whether it is actually behind.
    const { stdout } = await gitExecFileAsync(
      ['rev-list', '--left-right', '--count', `${parsed.fullRef}...${remoteTrackingRef}`],
      { cwd: repoPath }
    )
    const parsedDrift = parseRevListDrift(stdout)
    if (!parsedDrift || parsedDrift.ahead !== 0) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    const { stdout: localOidOutput } = await gitExecFileAsync(
      ['rev-parse', '--verify', `${parsed.fullRef}^{commit}`],
      { cwd: repoPath }
    )
    localOid = localOidOutput.trim()
    if (!localOid) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    const { stdout: remoteOidOutput } = await gitExecFileAsync(
      ['rev-parse', '--verify', `${remoteTrackingRef}^{commit}`],
      { cwd: repoPath }
    )
    remoteOid = remoteOidOutput.trim()
    if (!remoteOid) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    await gitExecFileAsync(['merge-base', '--is-ancestor', localOid, remoteOid], { cwd: repoPath })
    drift = parsedDrift
  } catch {
    return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
  }

  try {
    // Why: if the local base branch is checked out anywhere, turning on the
    // setting would only update it when that owner worktree is clean.
    const { stdout: worktreeListOutput } = await gitExecFileAsync(
      ['worktree', 'list', '--porcelain'],
      { cwd: repoPath }
    )
    const worktrees = parseWorktreeList(translateWslOutputPaths(worktreeListOutput, repoPath))
    const ownerWorktree = worktrees.find((wt) => wt.branch === parsed.fullRef)

    if (ownerWorktree) {
      const { stdout: status } = await gitExecFileAsync(
        ['status', '--porcelain', '--untracked-files=no'],
        { cwd: ownerWorktree.path }
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

    // Why: localBranch isn't checked out anywhere, so there is no working tree
    // to desync — a bare ref fast-forward (update-ref) is safe. Omitting
    // ownerWorktreePath signals the mutating path to take that branch.
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
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase']
): Promise<LocalBaseRefUpdateSuggestion | undefined> {
  const evaluation = await evaluateLocalBaseRefRefreshability(
    repoPath,
    baseBranch,
    remoteTrackingRef,
    remoteTrackingBase
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
  effectiveBase: string
): Promise<void> {
  const configKey = `branch.${branch}.base`
  try {
    await gitExecFileAsync(['config', '--local', '--replace-all', configKey, effectiveBase], {
      cwd: worktreePath
    })
  } catch (error) {
    console.warn(`addWorktree: failed to set ${configKey} for ${worktreePath}`, error)
    try {
      // Why: reused branch names may carry stale base metadata; if replacement
      // fails, remove the old value so consumers do not trust outdated lineage.
      await gitExecFileAsync(['config', '--local', '--unset-all', configKey], {
        cwd: worktreePath
      })
    } catch (unsetError) {
      console.warn(
        `addWorktree: failed to unset stale ${configKey} for ${worktreePath}`,
        unsetError
      )
    }
  }
}

async function unsetWorktreeCreationBase(worktreePath: string, branch: string): Promise<void> {
  try {
    await gitExecFileAsync(['config', '--local', '--unset-all', `branch.${branch}.base`], {
      cwd: worktreePath
    })
  } catch {
    // Best-effort cleanup; missing keys and locked config both leave the
    // original sparse setup error as the actionable failure.
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

async function readWorktreeList(repoPath: string): Promise<GitWorktreeInfo[]> {
  try {
    const { stdout } = await gitExecFileAsync(['worktree', 'list', '--porcelain', '-z'], {
      cwd: repoPath
    })
    return parseWorktreeList(stdout, { nulDelimited: true })
  } catch (error) {
    if (!isUnsupportedWorktreeListZError(error)) {
      throw error
    }
  }

  // Why: `-z` is required to preserve worktree paths containing newlines, but
  // Git <2.36 rejects it. Keep the old parser as a compatibility fallback.
  const { stdout } = await gitExecFileAsync(['worktree', 'list', '--porcelain'], {
    cwd: repoPath
  })
  return parseWorktreeList(stdout)
}

/**
 * List all worktrees for a git repo at the given path.
 */
export async function listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
  try {
    const worktrees = (await readWorktreeList(repoPath)).map((worktree) => {
      const translatedPath = translateWorktreePath(worktree.path, repoPath)
      return translatedPath === worktree.path ? worktree : { ...worktree, path: translatedPath }
    })
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
    // Why: a silent catch turns git compatibility or repo-state failures into
    // opaque downstream errors like "Worktree created but not found in listing".
    // Surface the cause so future regressions show up immediately.
    console.warn(`[git/worktree] listWorktrees failed for ${repoPath}:`, err)
    return []
  }
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

  // Why: worktree refreshes run on git-status polling paths. Many worktrees can
  // otherwise fan out `.git`/sparse-checkout filesystem probes all at once.
  const workerCount = Math.min(SPARSE_CHECKOUT_DETECTION_CONCURRENCY, worktrees.length)
  await Promise.all(Array.from({ length: workerCount }, () => detectNext()))
  return annotated
}

async function refreshLocalBaseRefForWorktreeCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase']
): Promise<LocalBaseRefRefreshResult | undefined> {
  const evaluation = await evaluateLocalBaseRefRefreshability(
    repoPath,
    baseBranch,
    remoteTrackingRef,
    remoteTrackingBase
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
        { cwd: repoPath }
      )
      const worktrees = parseWorktreeList(translateWslOutputPaths(worktreeListOutput, repoPath))
      const currentOwner = worktrees.find((wt) => wt.branch === evaluation.fullRef)
      if (!currentOwner || currentOwner.path !== evaluation.ownerWorktreePath) {
        return { ...resultBase, status: 'skipped_error' }
      }
      const { stdout: status } = await gitExecFileAsync(
        ['status', '--porcelain', '--untracked-files=no'],
        { cwd: currentOwner.path }
      )
      if (status.trim()) {
        return {
          ...resultBase,
          status: 'skipped_dirty_worktree',
          ownerWorktreePath: currentOwner.path
        }
      }
      await gitExecFileAsync(['reset', '--hard', evaluation.remoteOid], { cwd: currentOwner.path })
      return { ...resultBase, status: 'updated', ownerWorktreePath: currentOwner.path }
    }

    // Why: no owner worktree — fast-forward the bare ref. The expected-old-OID
    // form makes this a no-op-safe compare-and-swap if the ref moved since the
    // evaluation snapshot.
    await gitExecFileAsync(
      ['update-ref', evaluation.fullRef, evaluation.remoteOid, evaluation.localOid],
      { cwd: repoPath }
    )
    return { ...resultBase, status: 'updated' }
  } catch {
    // update-ref/reset can fail on locked refs, filesystem errors, or unusual
    // worktree states. Worktree creation should still proceed.
    return { ...resultBase, status: 'skipped_error' }
  }
}

/**
 * Create a new worktree.
 * @param repoPath - Path to the main repo (or bare repo)
 * @param worktreePath - Absolute path where the worktree will be created
 * @param branch - Branch name for the new worktree
 * @param baseBranch - Optional base branch to create from (defaults to HEAD)
 * @remarks Side effect: passes `--no-track`, writes `branch.<branch>.base`
 * for new-branch worktrees with a base ref, and may write
 * `push.autoSetupRemote=true` to the repo's shared config. Config writes are
 * best-effort and warn-only. See body comments below for the full rationale.
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
    // Why: --no-track keeps the new branch from inheriting the base ref's
    // upstream, so `git status` doesn't report "behind by N" against the base
    // pre-publish and tools/agents don't misread an unpublished branch as
    // out-of-sync. First push sets the upstream — see push.autoSetupRemote
    // below for the terminal ergonomics.
    args.push('--no-track', '-b', branch, worktreePath)
    if (baseBranch) {
      effectiveBase = await resolveWorktreeAddBaseRef(baseBranch, (qualifiedRef) =>
        hasWorktreeBaseCommitRef(repoPath, qualifiedRef)
      )
      // Why: resolving the creation base first distinguishes real
      // remote-tracking refs from slash-containing local branch names.
      // The mutation stays behind the explicit setting so the default
      // remains conservative.
      if (refreshLocalBaseRef) {
        localBaseRefRefresh = await refreshLocalBaseRefForWorktreeCreate(
          repoPath,
          baseBranch,
          effectiveBase,
          options.remoteTrackingBase
        )
      } else if (options.suggestLocalBaseRefUpdate) {
        localBaseRefUpdateSuggestion = await getLocalBaseRefUpdateSuggestionForWorktreeCreate(
          repoPath,
          baseBranch,
          effectiveBase,
          options.remoteTrackingBase
        )
      }
      args.push(effectiveBase)
    }
  }
  await gitExecFileAsync(args, { cwd: repoPath })

  if (options.checkoutExistingBranch) {
    return localBaseRefRefresh ? { localBaseRefRefresh } : {}
  }

  if (effectiveBase) {
    await persistWorktreeCreationBase(worktreePath, branch, effectiveBase)
  }

  // SSH parity: src/relay/git-handler-worktree-ops.ts addWorktreeOp mirrors this exact
  // probe-and-write state machine. If you change the logic here, update
  // the relay handler in lockstep so local and SSH paths stay aligned.
  //
  // Why: with --no-track there is no upstream until first push. Setting
  // push.autoSetupRemote=true makes a plain `git push` from the terminal
  // create origin/<branch> and set it as upstream automatically — matching
  // user expectations from modern git without requiring `-u`. Note that
  // `--local` on a linked worktree writes to the shared common-dir config,
  // so this affects the whole repo, not just this worktree. That is
  // intentional and acceptable: the value is benign and idempotent, and
  // every Orca-created worktree wants the same default. True per-worktree
  // scope would require enabling extensions.worktreeConfig=true repo-wide,
  // which is a larger change we deliberately avoid.
  //
  // Notes on the design:
  // - push.autoSetupRemote is honored by git >= 2.37; older clients ignore
  //   the value, so `git push` falls back to the pre-2.37 "no upstream"
  //   error and the user runs `git push -u` once.
  // - Failures here are warn-only: config writes are best-effort and a
  //   missing write degrades to the same fallback as old git.
  // - The write is skipped when any value is already set (local, global,
  //   or system) so a deliberate user `false` is preserved.
  // - Not rolled back on creation failure: addSparseWorktree's catch path
  //   removes the worktree but does not unset this config. That is consistent
  //   with the "benign and idempotent" rationale above — every Orca-created
  //   worktree wants this default, and a future creation will silently re-set
  //   it via the existing-value check anyway.
  try {
    // Why: `--get` (not `--local --get`) so a value set at any scope
    // (local/global/system) counts as "user already chose" and we don't
    // overwrite it.
    let alreadySet = false
    try {
      await gitExecFileAsync(['config', '--get', 'push.autoSetupRemote'], {
        cwd: worktreePath
      })
      alreadySet = true
    } catch (readError) {
      // Why: `git config --get` exits 1 only when the key is unset at every
      // scope. Any other exit code means a real read failure (corrupt config,
      // locked file, parse error) — surface that via the outer catch instead
      // of silently overwriting whatever value the user actually has.
      const code = (readError as { code?: unknown })?.code
      if (code !== 1) {
        throw readError
      }
    }
    if (!alreadySet) {
      await gitExecFileAsync(['config', '--local', 'push.autoSetupRemote', 'true'], {
        cwd: worktreePath
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
    await gitExecFileAsync(['sparse-checkout', 'init', '--cone'], { cwd: worktreePath })
    await gitExecFileAsync(['sparse-checkout', 'set', '--', ...directories], { cwd: worktreePath })
    await gitExecFileAsync(['checkout', branch], { cwd: worktreePath })
    return addResult
  } catch (error) {
    const wrapped: SparseWorktreeCreateError =
      error instanceof Error ? (error as SparseWorktreeCreateError) : new Error(String(error))
    if (created) {
      if (!options.checkoutExistingBranch) {
        await unsetWorktreeCreationBase(worktreePath, branch)
      }
      try {
        await removeWorktree(repoPath, worktreePath, true, {
          deleteBranch: !options.checkoutExistingBranch,
          // Why: rolling back a failed creation — the just-created branch has no
          // user commits, so force-delete it rather than preserving an orphan.
          forceBranchDelete: !options.checkoutExistingBranch
        })
      } catch {
        wrapped.cleanupFailed = true
        // Why: the user needs to know that manual cleanup may be required —
        // otherwise a half-created worktree silently lingers on disk.
        wrapped.message = `${wrapped.message} (cleanup also failed — the partially created worktree at "${worktreePath}" may need manual removal)`
      }
    }
    throw wrapped
  }
}

/**
 * Move a worktree's directory to a new path with `git worktree move`, which
 * relocates the working tree and rewrites git's gitdir pointers so the linkage
 * stays intact — a raw `fs.rename` would corrupt the `.git` file and the
 * `.git/worktrees/<name>/gitdir` back-pointer. Local worktrees only: the
 * first-work folder rename skips SSH/remote, so there is no relay parity handler
 * for this op. The caller owns migrating Orca's path-derived worktree identity
 * after a successful move, and pre-checks that the destination is free.
 */
export async function moveWorktree(
  repoPath: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  await gitExecFileAsync(['worktree', 'move', oldPath, newPath], { cwd: repoPath })
}

/**
 * Remove a worktree.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
  // Why: forceBranchDelete is for cleaning up a worktree this code just created
  // (e.g. rollback of a failed creation) where the fresh branch has no user work
  // and must be removed outright. User-initiated deletes leave it false so unmerged
  // commits are preserved.
  options: { deleteBranch?: boolean; forceBranchDelete?: boolean } = {}
): Promise<RemoveWorktreeResult> {
  const worktreesBeforeRemoval = await listWorktrees(repoPath)
  const removedWorktree = worktreesBeforeRemoval.find((worktree) =>
    areWorktreePathsEqual(worktree.path, worktreePath)
  )
  const branchName = normalizeLocalBranchRef(removedWorktree?.branch ?? '')
  const branchHead = removedWorktree?.head ?? ''

  const args = ['worktree', 'remove']
  if (force) {
    args.push('--force')
  }
  args.push(worktreePath)
  await gitExecFileAsync(args, { cwd: repoPath })
  await gitExecFileAsync(['worktree', 'prune'], { cwd: repoPath })

  if (!branchName) {
    return {}
  }
  if (options.deleteBranch === false) {
    return {}
  }

  // Why: `git worktree list` can still include stale sibling records until
  // `git worktree prune` runs. Re-list after prune so branch cleanup only skips
  // when a still-live worktree actually keeps that branch checked out.
  const worktreesAfterPrune = await listWorktrees(repoPath)
  const branchStillInUse = worktreesAfterPrune.some(
    (worktree) => normalizeLocalBranchRef(worktree.branch) === branchName
  )
  if (branchStillInUse) {
    return {}
  }

  try {
    // Why: `git worktree remove` only detaches the filesystem entry. Orca also
    // drops the now-unused local branch here so delete-worktree does not leave
    // behind orphaned feature branches unless another worktree still points at it.
    // Use `-d` (not `-D`): Git refuses to delete a branch with commits not merged
    // into its upstream or HEAD, so unpublished work is preserved instead of
    // force-deleted. forceBranchDelete opts into `-D` for failed-creation rollback,
    // where the fresh branch has no user work to protect.
    const deleteFlag = options.forceBranchDelete ? '-D' : '-d'
    await gitExecFileAsync(['branch', deleteFlag, '--', branchName], { cwd: repoPath })
    return {}
  } catch (error) {
    if (!options.forceBranchDelete && branchHead) {
      try {
        if (
          await deleteAlreadyMergedBranchAfterSafeDeleteFailure(repoPath, branchName, branchHead)
        ) {
          return {}
        }
      } catch (alreadyMergedDeleteError) {
        // Why: the worktree is already gone; a raced branch cleanup should
        // degrade to the preserved-branch recovery path instead of failing delete.
        console.warn(
          `[git] Failed to delete already-merged local branch "${branchName}" after removing worktree`,
          alreadyMergedDeleteError
        )
      }
    }
    // Expected when the branch still has unmerged/unpublished commits: keep it.
    // Deleting a worktree must never silently discard commits.
    console.warn(
      `[git] Preserved local branch "${branchName}" after removing worktree (not fully merged)`,
      error
    )
    return { preservedBranch: { branchName, ...(branchHead ? { head: branchHead } : {}) } }
  }
}

async function deleteAlreadyMergedBranchAfterSafeDeleteFailure(
  repoPath: string,
  branchName: string,
  branchHead: string
): Promise<boolean> {
  const runGit = (args: string[]) => gitExecFileAsync(args, { cwd: repoPath })
  const targetRefs = await getBranchCleanupTargetRefs(runGit, branchName)
  await refreshBranchCleanupTargetRefs(runGit, targetRefs)
  // Why: squash merges rewrite commit IDs, so `branch -d` can reject a branch
  // whose changes are already on the base ref. Delete only when Git can prove
  // the branch contributes no tree changes to that base.
  if (!(await branchHasNoUnmergedChangesOnAnyTarget(runGit, branchName, targetRefs))) {
    return false
  }
  await forceDeleteLocalBranch(repoPath, branchName, branchHead)
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
  // Why: stale toast actions must not delete a branch that moved after Git
  // preserved it. `update-ref` deletes only if the ref still has expectedHead.
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
    // Best-effort parity with `git branch -D`; stale config is harmless and
    // should not make the already-deleted ref look like a failed delete.
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
  force = false
): Promise<void> {
  if (force) {
    return
  }

  const { stdout } = await gitExecFileAsync(['status', '--porcelain', '--untracked-files=all'], {
    cwd: worktreePath
  })
  if (!stdout.trim()) {
    return
  }

  const error = new Error('Worktree has uncommitted or untracked changes.')
  ;(error as Error & { stdout?: string }).stdout = stdout
  throw error
}

function translateWorktreePath(worktreePath: string, repoPath: string): string {
  const prefix = 'worktree '
  const translated = translateWslOutputPaths(`${prefix}${worktreePath}`, repoPath)
  return translated.startsWith(prefix) ? translated.slice(prefix.length) : worktreePath
}

async function detectSparseCheckout(worktreePath: string): Promise<boolean> {
  // Why: `listWorktrees` runs on every 3-second git-status poll and on every
  // worktree refresh, so this probe fires N times per poll for N worktrees.
  // The previous `git sparse-checkout list` subprocess made that N*poll extra
  // git processes, which regressed app responsiveness on machines with many
  // worktrees (see PR #1131 revert in #1290). A single fs.stat on the
  // per-worktree sparse-checkout config file is ~two orders of magnitude
  // cheaper and has the same truthiness semantics: Git writes this file when
  // sparse checkout is enabled for the worktree and does not write it
  // otherwise.
  //
  // Why per-worktree gitdir and not `<worktreePath>/.git/info/sparse-checkout`:
  // linked worktrees have a `.git` file that points at
  // `<repo>/.git/worktrees/<name>`, and that is where Git stores the
  // worktree-local sparse-checkout config. `core.sparseCheckout` itself is
  // shared across all worktrees, so the presence of the config file is the
  // correct per-worktree signal.
  try {
    const gitDir = await resolveGitDir(worktreePath)
    const stats = await stat(join(gitDir, 'info', 'sparse-checkout'))
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}
