import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../shared/worktree/base-ref-drift-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { createCoalescingKeyedRunner } from '../../shared/coalescing-keyed-runner'
import { parseWorktreeList } from '../../shared/git-worktree-porcelain-parser'
import {
  fastForwardLocalBaseBranch,
  inspectLocalBaseBranch,
  toLocalBaseRefRefreshResult,
  type LocalBaseBranchFastForwardOutcome,
  type LocalBaseBranchGit
} from '../../shared/worktree/local-base-branch-fast-forward'
import { gitExecFileAsync, translateWslOutputPaths } from './runner'
import { runWithGitReadCacheInvalidation } from './status'
import type { AddWorktreeOptions, GitWorktreeExecOptions } from './worktree-operation-options'

// Why: the create reports the refresh result, and a mutating git process has no timeout; past this
// a create stops waiting and reports nothing, while the one in-flight refresh keeps its checkout.
export const LOCAL_BASE_REF_REFRESH_WAIT_MS = 30_000

// Why: two runs moving one checkout at once collide on index.lock and misread each other's half-done
// merge; one run per branch at a time, shared only by creates toward the same target, leaves nothing to race.
const runPerLocalBaseBranch = createCoalescingKeyedRunner<LocalBaseBranchFastForwardOutcome>()

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
    // Why: the run can outlive this create's wait, so it clears git read caches itself when it moves main.
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

function localBaseBranchGit(options: GitWorktreeExecOptions): LocalBaseBranchGit {
  // Why: the run is shared by every create that joins it, so no one create's abort signal or timeout may cut it short.
  const execOptions = (cwd: string) => ({
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
  })
  return {
    exec: (args, cwd) => gitExecFileAsync(args, execOptions(cwd)),
    listWorktrees: async (repoPath) => {
      const { stdout } = await gitExecFileAsync(
        ['worktree', 'list', '--porcelain'],
        execOptions(repoPath)
      )
      return parseWorktreeList(translateWslOutputPaths(stdout, repoPath, options))
    }
  }
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
