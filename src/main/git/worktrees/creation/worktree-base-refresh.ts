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
import {
  readGitDirState,
  readLinkedWorktreeDir,
  REFTABLE_HEAD_PLACEHOLDER
} from './git-dir-branch-state'
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
  const gitPathOf = (repoPath: string, path: string) =>
    isAbsolute(path)
      ? translateWslOutputPath(path, repoPath, routed(repoPath))
      : join(repoPath, path)
  const repoGitDirsOf = async (repoPath: string): Promise<RepoGitDirs> => {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--is-bare-repository', '--git-dir', '--git-common-dir'],
      execOptions(repoPath)
    )
    // Only strip line endings: a path may end in spaces.
    const [bareLine, gitDirLine, commonDirLine] = stdout.split(/\r?\n/)
    if (!gitDirLine || !commonDirLine) {
      throw new Error(`git rev-parse printed no git dirs for ${repoPath}`)
    }
    const gitDir = gitPathOf(repoPath, gitDirLine)
    const commonDir = gitPathOf(repoPath, commonDirLine)
    const isMain =
      normalizeRuntimePathForComparison(gitDir) === normalizeRuntimePathForComparison(commonDir)
    // From a linked worktree Git reports false; its main is bare when core.bare says so.
    const bare = bareLine === 'true' || (!isMain && (await readCoreBare(repoPath)))
    return { commonDir, isMain, bare }
  }
  const readCoreBare = async (repoPath: string) => {
    try {
      const { stdout } = await gitExecFileAsync(
        ['config', '--bool', '--get', 'core.bare'],
        execOptions(repoPath)
      )
      return stdout.trim() === 'true'
    } catch {
      // Unset or unreadable: count the main checkout as in use.
      return false
    }
  }
  // Reads each git dir's HEAD instead of listing every worktree, which costs seconds at thousands of worktrees.
  const readBranchUse = async (repoPath: string, fullRef: string) => {
    const dirs = await repoGitDirsOf(repoPath)
    const { heads, reserved } = await readGitDirState(dirs.commonDir)
    if (reserved.has(fullRef)) {
      return { reserved: true }
    }
    const owner = [...heads.entries()].find(
      ([gitDir, head]) => head === `ref: ${fullRef}` && !(dirs.bare && gitDir === dirs.commonDir)
    )?.[0]
    let ownerPath: string | undefined
    if (owner === dirs.commonDir) {
      // Only the main worktree's own path is known without asking Git.
      ownerPath = dirs.isMain ? repoPath : undefined
    } else if (owner !== undefined) {
      ownerPath = await readLinkedWorktreePath(owner, repoPath)
    }
    // Reftable HEADs, or an owner whose path the files do not give, need Git's own listing.
    if (
      [...heads.values()].includes(REFTABLE_HEAD_PLACEHOLDER) ||
      (owner !== undefined && ownerPath === undefined)
    ) {
      const fromGit = (await listWorktrees(repoPath)).find((wt) => wt.branch === fullRef)
      return { reserved: false, ...(fromGit ? { ownerPath: fromGit.path } : {}) }
    }
    return { reserved: false, ...(ownerPath === undefined ? {} : { ownerPath }) }
  }
  const readLinkedWorktreePath = async (gitDir: string, repoPath: string) => {
    const path = await readLinkedWorktreeDir(gitDir)
    if (path === undefined) {
      return undefined
    }
    return isAbsolute(path)
      ? translateWslOutputPath(path, repoPath, routed(repoPath))
      : join(gitDir, path)
  }
  return {
    exec: (args, cwd) => gitExecFileAsync(args, execOptions(cwd)),
    readBranchUse,
    updateRefUnlessInUse: async (repoPath, fullRef, args) => {
      const { commonDir, bare } = await repoGitDirsOf(repoPath)
      let inUse = false
      try {
        await gitExecFileAsync(args, {
          ...execOptions(repoPath),
          beforeStart: async () => {
            const { heads, reserved } = await readGitDirState(commonDir)
            inUse =
              reserved.has(fullRef) ||
              [...heads].some(
                ([gitDir, head]) =>
                  // A bare repo's own HEAD names a branch without checking it out.
                  !(bare && gitDir === commonDir) &&
                  // Reftable keeps HEAD elsewhere and leaves this placeholder: fail closed.
                  (head === `ref: ${fullRef}` || head === REFTABLE_HEAD_PLACEHOLDER)
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

type RepoGitDirs = {
  commonDir: string
  /** The repo path's own git dir is the common dir: it is the main worktree or the bare repo. */
  isMain: boolean
  /** The common dir's own HEAD names a branch nothing has checked out. */
  bare: boolean
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
