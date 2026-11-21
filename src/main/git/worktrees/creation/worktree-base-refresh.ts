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
import { hasLinkedPlaceholderHead, isSamePath, readGitDirState } from './git-dir-branch-state'
import { resolveAliasedBranch, resolveBranchCheckouts } from './branch-checkout-resolution'
import { readOwnerCheckoutPath } from './checkout-dir-from-files'
import { checkWithDeadline, waitAtMost } from './file-check-deadline'
import { parseRemoteTrackingLocalBaseRef } from './remote-tracking-local-base-ref'
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
// The admitted pre-write check takes well under a second at thousands of worktrees.
export const PRE_WRITE_CHECK_TIMEOUT_MS = 15_000

// Serialize per branch to avoid ref-lock races; coalesce only matching targets.
const runPerLocalBaseBranch = createCoalescingKeyedRunner<LocalBaseBranchFastForwardOutcome>()

// One checkout fast-forward per repo; creates during one share a single follow-up to the latest remote ref.
const runPerRepoCheckoutFastForward = createCoalescingKeyedRunner<void>()

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
  const refs = { repoPath, fullRef: parsed.fullRef, remoteTrackingRef }
  // Advisory: a stalled file read must not hold the create; an abandoned inspection stops reading and runs no Git.
  const inspection = await checkWithDeadline(
    `${options.wslDistro ?? ''}\0${normalizeRuntimePathForComparison(repoPath)}`,
    LOCAL_BASE_REF_REFRESH_WAIT_MS,
    undefined,
    (stop) =>
      inspectLocalBaseBranch(localBaseBranchGit(options, {}, stop), refs, { occupancyOnly: true })
  )
  return inspection?.status === 'behind'
    ? { baseRef: parsed.baseRef, localBranch: parsed.localBranch, behind: inspection.behind }
    : undefined
}

function localBaseBranchGit(
  options: GitWorktreeExecOptions,
  admission: Pick<GitExecOptions, 'admissionExempt'> = {},
  abandoned: () => boolean = () => false
): LocalBaseBranchGit {
  // Shared refreshes cannot use any individual create's cancellation signal or timeout.
  const execOptions = (cwd: string): GitExecOptions => ({
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {}),
    ...admission
  })
  // An abandoned inspection starts no more Git.
  const runGit: typeof gitExecFileAsync = (args, opts) =>
    abandoned()
      ? Promise.reject(new Error('Inspection abandoned'))
      : gitExecFileAsync(args, { ...opts, canStart: () => !abandoned() })
  // The runner may route a Windows drive repo into WSL; its Linux output paths need the same distro.
  const routed = (cwd: string) => routeLocalGitOptions({ cwd, wslDistro: options.wslDistro })
  const listWorktrees = async (repoPath: string) => {
    const { stdout } = await withRepositoryGitCause(
      repoPath,
      options,
      { family: 'catalog', reason: 'creation-base-refresh', cache: 'uncached' },
      () => runGit(['worktree', 'list', '--porcelain'], execOptions(repoPath))
    )
    return parseWorktreeList(translateWslOutputPaths(stdout, repoPath, routed(repoPath)))
  }
  const commonDirOf = async (repoPath: string) => {
    const { stdout } = await runGit(['rev-parse', '--git-common-dir'], execOptions(repoPath))
    // Only strip the line ending: a path may end in spaces.
    const raw = stdout.replace(/\r?\n$/, '')
    const path = isAbsolute(raw)
      ? translateWslOutputPath(raw, repoPath, routed(repoPath))
      : join(repoPath, raw)
    return { raw, path }
  }
  // core.bare as the common dir reads it (a linked checkout's config could claim bare and hide the primary); unset, Git infers bare only for the git dir itself.
  const bareRepos = new Map<string, Promise<boolean>>()
  const isBareRepo = (repoPath: string, commonDir: { raw: string; path: string }) => {
    const known =
      bareRepos.get(commonDir.path) ??
      runGit(
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
    exec: (args, cwd) => runGit(args, execOptions(cwd)),
    // HEAD files answer the common cases; listing every worktree costs seconds at thousands of them.
    readBranchUse: async (repoPath, fullRef, occupancyOnly = false) => {
      const commonDir = await commonDirOf(repoPath)
      const state = await readGitDirState(commonDir.path, abandoned)
      // Only a sole direct owner is located, and it stays owners[0].
      let located: Promise<string | undefined> | undefined
      const locate = (gitDir: string) => (located ??= ownerPathOf(repoPath, gitDir, commonDir.path))
      const { branch, reserved } = await resolveAliasedBranch(
        state,
        commonDir.path,
        fullRef,
        abandoned
      )
      if (reserved) {
        return { reserved: true }
      }
      // A linked reftable placeholder already needs Git's listing, whatever core.bare says.
      const use =
        branch === undefined || hasLinkedPlaceholderHead(state, commonDir.path)
          ? { kind: 'unknown' as const }
          : await resolveBranchCheckouts(state, commonDir.path, branch, {
              bareCommonDir: await bareDirOf(repoPath, commonDir),
              firstOwnerSettles: occupancyOnly,
              canLocate: async (gitDir) => (await locate(gitDir)) !== undefined,
              stop: abandoned
            })
      if (use.kind === 'free') {
        return { reserved: false }
      }
      // Skipping callers never read the path.
      if (occupancyOnly && use.kind === 'owned') {
        return { reserved: false, ownerPath: repoPath }
      }
      const [onlyOwner, ...others] = use.kind === 'owned' ? use.gitDirs : []
      // No caller acts on these paths: several checkouts, or one of the branch an alias names, have nothing to fast-forward.
      const shared = { reserved: false, ownerPath: repoPath, sharedCheckout: true } as const
      if (others.length > 0 || (onlyOwner && branch !== fullRef)) {
        return shared
      }
      const ownerPath = onlyOwner ? await locate(onlyOwner) : undefined
      if (ownerPath !== undefined) {
        return { reserved: false, ownerPath }
      }
      // What the files cannot tell: Git's listing decides.
      const owner = (await listWorktrees(repoPath)).find(
        (wt) => wt.branch === fullRef || wt.branch === branch
      )
      return !owner
        ? { reserved: false }
        : owner.branch === fullRef
          ? { reserved: false, ownerPath: owner.path }
          : shared
    },
    updateRefUnlessInUse: async (repoPath, fullRef, args) => {
      const commonDir = await commonDirOf(repoPath)
      // The inspection just ran; resolve before admission, as the recheck below must not run Git in the slot.
      const bareCommonDir = await bareDirOf(repoPath, commonDir)
      let inUse = false
      try {
        await gitExecFileAsync(args, {
          ...execOptions(repoPath),
          // Recheck from files once admitted: running Git here could wait on its own slot.
          beforeStart: async () => {
            // Fail closed and give back the slot if the files stall; a late answer never starts the write.
            inUse = await checkWithDeadline(
              commonDir.path,
              PRE_WRITE_CHECK_TIMEOUT_MS,
              true,
              async (stop) => {
                const state = await readGitDirState(commonDir.path, stop)
                const { branch, reserved } = await resolveAliasedBranch(
                  state,
                  commonDir.path,
                  fullRef,
                  stop
                )
                if (reserved || branch === undefined) {
                  return true
                }
                const use = await resolveBranchCheckouts(state, commonDir.path, branch, {
                  bareCommonDir,
                  firstOwnerSettles: true,
                  stop
                })
                return use.kind !== 'free'
              }
            )
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

import { withRepositoryGitCause } from '../../repository-git-cause'
