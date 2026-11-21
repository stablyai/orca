import { isAbsolute, join } from 'node:path'
import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../../../shared/worktree/base-refs/base-ref-drift-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { createCoalescingKeyedRunner } from '../../../../shared/concurrency/coalescing-keyed-runner'
import { parseWorktreeList } from '../../../../shared/git/worktrees/git-worktree-porcelain-parser'
import {
  fastForwardCheckedOutLocalBaseBranch,
  fastForwardLocalBaseBranch,
  inspectLocalBaseBranch,
  toLocalBaseRefRefreshResult,
  type LocalBaseBranchFastForwardOutcome,
  type LocalBaseBranchGit
} from '../../../../shared/worktree/base-refs/local-base-branch-fast-forward'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { isSamePath, readGitDirState } from './git-dir-branch-state'
import { readOwnerCheckoutPath, resolveBranchCheckouts } from './branch-checkout-resolution'
import {
  translateWslOutputPath,
  translateWslOutputPaths
} from '../../command-runner/host-routing/wsl-path-translation'
import { routeLocalGitOptions } from '../../command-runner/host-routing/local-git-runtime-route'
import type { GitExecOptions } from '../../command-runner/git-exec-options'
import { runWithGitReadCacheInvalidation } from '../../source-control/git-read-cache-invalidation'
import type { AddWorktreeOptions, GitWorktreeExecOptions } from '../worktree-operation-options'

// Bound the create's wait on the shared ref-only refresh.
export const LOCAL_BASE_REF_REFRESH_WAIT_MS = 30_000

// Serialize per branch to avoid ref-lock races; coalesce only matching targets.
const runPerLocalBaseBranch = createCoalescingKeyedRunner<LocalBaseBranchFastForwardOutcome>()

// One checkout fast-forward per repo; creates during one share a single follow-up to the latest remote ref.
const runPerRepoCheckoutFastForward = createCoalescingKeyedRunner<void>()

export function parseRemoteTrackingLocalBaseRef(
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

  // Only proven remote-tracking refs warrant refresh warnings, not slash-named local branches.
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

export async function refreshLocalBaseRefForWorktreeCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefRefreshResult | undefined> {
  const parsed = parseRemoteTrackingLocalBaseRef(baseBranch, remoteTrackingRef, remoteTrackingBase)
  if (!parsed) {
    return undefined
  }
  const key = `${options.wslDistro ?? ''}\0${normalizeRuntimePathForComparison(repoPath)}\0${parsed.fullRef}`
  const git = localBaseBranchGit(options)
  const outcome = await waitAtMost(
    // The shared run may outlive its create, so it owns cache invalidation.
    runPerLocalBaseBranch(key, remoteTrackingRef, () =>
      runWithGitReadCacheInvalidation(() =>
        fastForwardLocalBaseBranch(git, { repoPath, fullRef: parsed.fullRef, remoteTrackingRef })
      )
    ),
    LOCAL_BASE_REF_REFRESH_WAIT_MS
  )
  if (!outcome) {
    console.warn(
      `addWorktree: stopped waiting for the local ${parsed.localBranch} refresh after ${LOCAL_BASE_REF_REFRESH_WAIT_MS}ms`
    )
  }
  return toLocalBaseRefRefreshResult(parsed, outcome)
}

/** Fast-forward a checked-out base in its own checkout once a create is done; nothing waits on it. */
export function fastForwardCheckedOutLocalBaseAfterCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  options: AddWorktreeOptions
): void {
  const parsed = parseRemoteTrackingLocalBaseRef(
    baseBranch,
    remoteTrackingRef,
    options.remoteTrackingBase
  )
  if (!parsed) {
    return
  }
  const key = `${options.wslDistro ?? ''}\0${normalizeRuntimePathForComparison(repoPath)}`
  // Admission-exempt (bounded by the per-repo runner) so a stalled checkout never holds a slot creates wait on; no deadline, since killing a merge mid-checkout strands a half-updated tree.
  const git = localBaseBranchGit(options, { admissionExempt: true })
  void runPerRepoCheckoutFastForward(key, parsed.fullRef, () =>
    runWithGitReadCacheInvalidation(() =>
      fastForwardCheckedOutLocalBaseBranch(git, {
        repoPath,
        fullRef: parsed.fullRef,
        remoteTrackingRef
      })
    )
  ).catch((error: unknown) => {
    console.warn('addWorktree: checked-out local base fast-forward failed unexpectedly', error)
  })
}

export async function getLocalBaseRefUpdateSuggestionForWorktreeCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefUpdateSuggestion | undefined> {
  const parsed = parseRemoteTrackingLocalBaseRef(baseBranch, remoteTrackingRef, remoteTrackingBase)
  if (!parsed) {
    return undefined
  }
  const inspection = await inspectLocalBaseBranch(localBaseBranchGit(options), {
    repoPath,
    fullRef: parsed.fullRef,
    remoteTrackingRef
  })
  return inspection.status === 'behind'
    ? { baseRef: parsed.baseRef, localBranch: parsed.localBranch, behind: inspection.behind }
    : undefined
}

function localBaseBranchGit(
  options: GitWorktreeExecOptions,
  admission: Pick<GitExecOptions, 'admissionExempt'> = {}
): LocalBaseBranchGit {
  // Shared refreshes cannot use any individual create's cancellation signal or timeout.
  const execOptions = (cwd: string): GitExecOptions => ({
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {}),
    ...admission
  })
  // The runner may route a Windows drive repo into WSL; its Linux output paths need the same distro.
  const routed = (cwd: string) => routeLocalGitOptions({ cwd, wslDistro: options.wslDistro })
  const listWorktrees = async (repoPath: string) => {
    const { stdout } = await withRepositoryGitCause(
      repoPath,
      options,
      { family: 'catalog', reason: 'creation-base-refresh', cache: 'uncached' },
      () => gitExecFileAsync(['worktree', 'list', '--porcelain'], execOptions(repoPath))
    )
    return parseWorktreeList(translateWslOutputPaths(stdout, repoPath, routed(repoPath)))
  }
  const commonDirOf = async (repoPath: string) => {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--git-common-dir'],
      execOptions(repoPath)
    )
    // Only strip the line ending: a path may end in spaces.
    const raw = stdout.replace(/\r?\n$/, '')
    const path = isAbsolute(raw)
      ? translateWslOutputPath(raw, repoPath, routed(repoPath))
      : join(repoPath, raw)
    return { raw, path }
  }
  // core.bare as the common dir reads it (config.worktree included); a linked checkout's config could claim bare and
  // hide a real primary checkout. Unset, Git infers bare only for the git dir itself. Asked once per refresh.
  const bareRepos = new Map<string, Promise<boolean>>()
  const isBareRepo = (repoPath: string, commonDir: { raw: string; path: string }) => {
    const known =
      bareRepos.get(commonDir.path) ??
      gitExecFileAsync(
        [`--git-dir=${commonDir.raw}`, 'config', '--bool', '--get', 'core.bare'],
        execOptions(repoPath)
      ).then(
        ({ stdout }) => stdout.trim() === 'true',
        async (error: unknown) => isConfigUnset(error) && isSamePath(repoPath, commonDir.path)
      )
    bareRepos.set(commonDir.path, known)
    return known
  }
  const bareDirOf = async (repoPath: string, commonDir: { raw: string; path: string }) =>
    (await isBareRepo(repoPath, commonDir)) ? commonDir.path : undefined
  const ownerPathOf = (repoPath: string, gitDir: string, commonDir: string) =>
    readOwnerCheckoutPath(repoPath, gitDir, commonDir, (path) =>
      translateWslOutputPath(path, repoPath, routed(repoPath))
    )
  return {
    exec: (args, cwd) => gitExecFileAsync(args, execOptions(cwd)),
    // HEAD files answer the common cases; listing every worktree costs seconds at thousands of them.
    readBranchUse: async (repoPath, fullRef, occupancyOnly = false) => {
      const commonDir = await commonDirOf(repoPath)
      const state = await readGitDirState(commonDir.path)
      if (state.reserved.has(fullRef)) {
        return { reserved: true }
      }
      const bareCommonDir = await bareDirOf(repoPath, commonDir)
      const use = await resolveBranchCheckouts(state, commonDir.path, fullRef, {
        bareCommonDir,
        firstOwnerSettles: occupancyOnly
      })
      if (use.kind === 'free') {
        return { reserved: false }
      }
      // Skipping callers never read the path.
      if (occupancyOnly && use.kind === 'owned') {
        return { reserved: false, ownerPath: repoPath }
      }
      const [onlyOwner, ...others] = use.kind === 'owned' ? use.gitDirs : []
      const ownerPath =
        onlyOwner && others.length === 0
          ? await ownerPathOf(repoPath, onlyOwner, commonDir.path)
          : undefined
      if (ownerPath !== undefined) {
        return { reserved: false, ownerPath }
      }
      // No caller acts on a shared checkout's path: the refresh and follow-up skip it.
      if (others.length > 0) {
        return { reserved: false, ownerPath: repoPath, sharedCheckout: true }
      }
      // What the files cannot tell: Git's listing decides.
      const owner = (await listWorktrees(repoPath)).find((wt) => wt.branch === fullRef)
      return { reserved: false, ...(owner ? { ownerPath: owner.path } : {}) }
    },
    // The inspection just ran; the admitted file recheck below guards the gap.
    updateRefUnlessInUse: async (repoPath, fullRef, args) => {
      const commonDir = await commonDirOf(repoPath)
      // Resolve before admission: the recheck below must not run Git while it holds the slot.
      const bareCommonDir = await bareDirOf(repoPath, commonDir)
      let inUse = false
      try {
        await gitExecFileAsync(args, {
          ...execOptions(repoPath),
          // Recheck from files once admitted: running Git here could wait on its own slot.
          beforeStart: async () => {
            const state = await readGitDirState(commonDir.path)
            inUse =
              state.reserved.has(fullRef) ||
              (
                await resolveBranchCheckouts(state, commonDir.path, fullRef, {
                  bareCommonDir,
                  firstOwnerSettles: true
                })
              ).kind !== 'free'
            return !inUse
          }
        })
      } catch (error) {
        if (inUse) {
          return false
        }
        throw error
      }
      return true
    }
  }
}

// `git config --get` exits 1 for an unset key.
function isConfigUnset(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 1
}

function waitAtMost<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}
import { withRepositoryGitCause } from '../../repository-git-cause'
