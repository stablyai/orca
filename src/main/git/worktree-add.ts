import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'
import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../shared/worktree/base-ref-drift-types'
import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { withRepoRefMaintenancePaused } from './local-repo-ref-maintenance'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'
import {
  getLocalBaseRefUpdateSuggestionForWorktreeCreate,
  parseRemoteTrackingLocalBaseRef,
  refreshLocalBaseRefForWorktreeCreate
} from './worktree-base-refresh'
import { resolveWorktreeBaseCommitOid } from './worktree-base-ref-probe'
import type {
  AddWorktreeOptions,
  AddWorktreeResult,
  GitWorktreeExecOptions
} from './worktree-operation-options'
import { gitExecOptions, resolveWorktreeAddTimeoutMs } from './worktree-operation-options'
import { bumpWorktreeScanGeneration } from './worktree-scan-cache'
import { assertNoPendingWorktreeRemovalConflict } from '../worktree-background-removal'

export type WorktreeAddBaseContext = Pick<AddWorktreeResult, 'localBaseRefUpdateSuggestion'> & {
  effectiveBase: string
  effectiveBaseOid?: string
  /** Started, not awaited: the worktree is created from the remote-tracking commit, so the refresh can overlap the checkout. Never rejects. */
  pendingLocalBaseRefRefresh?: Promise<LocalBaseRefRefreshResult | undefined>
}

export async function resolveWorktreeAddBaseContext(
  repoPath: string,
  baseBranch: string,
  refreshLocalBaseRef: boolean,
  options: AddWorktreeOptions,
  createdBranch: string
): Promise<WorktreeAddBaseContext> {
  let effectiveBaseOid: string | null = null
  const effectiveBase = await resolveWorktreeAddBaseRef(baseBranch, async (qualifiedRef) => {
    effectiveBaseOid = await resolveWorktreeBaseCommitOid(repoPath, qualifiedRef, options)
    return effectiveBaseOid !== null
  })
  // Why: `-b` refuses an existing branch, so creating the base's own local branch leaves nothing to refresh; probing it would race the overlapped add's branch write into a false "not fast-forward" warning.
  const createsLocalBaseBranch =
    parseRemoteTrackingLocalBaseRef(baseBranch, effectiveBase, options.remoteTrackingBase)
      ?.localBranch === createdBranch
  const pendingLocalBaseRefRefresh =
    refreshLocalBaseRef && !createsLocalBaseBranch
      ? refreshLocalBaseRefForWorktreeCreate(
          repoPath,
          baseBranch,
          effectiveBase,
          options.remoteTrackingBase,
          options
        ).catch((error: unknown) => {
          // Why: the create may already have succeeded by the time this settles; a refresh bug must not fail it.
          console.warn('addWorktree: local base ref refresh failed unexpectedly', error)
          return undefined
        })
      : undefined
  const localBaseRefUpdateSuggestion =
    !refreshLocalBaseRef && options.suggestLocalBaseRefUpdate
      ? await getLocalBaseRefUpdateSuggestionForWorktreeCreate(
          repoPath,
          baseBranch,
          effectiveBase,
          options.remoteTrackingBase,
          options
        )
      : undefined
  return {
    effectiveBase,
    // Refresh/suggestion work can span ref changes; only reuse the immediate resolution probe.
    ...(!refreshLocalBaseRef && !options.suggestLocalBaseRefUpdate && effectiveBaseOid
      ? { effectiveBaseOid }
      : {}),
    ...(pendingLocalBaseRefRefresh ? { pendingLocalBaseRefRefresh } : {}),
    ...(localBaseRefUpdateSuggestion ? { localBaseRefUpdateSuggestion } : {})
  }
}

export async function persistWorktreeCreationBase(
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

export async function configurePushAutoSetupRemote(
  worktreePath: string,
  options: GitWorktreeExecOptions
): Promise<void> {
  try {
    // Why: `--get` (not `--local --get`) treats a value at any scope as an explicit user choice.
    let alreadySet = false
    try {
      await gitExecFileAsync(['config', '--get', 'push.autoSetupRemote'], {
        ...gitExecOptions(worktreePath, options)
      })
      alreadySet = true
    } catch (readError) {
      // Why: exit 1 means unset; other codes are real read failures and must not overwrite config.
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
}

export async function unsetWorktreeCreationBase(
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
    return await withRepoRefMaintenancePaused('worktree-add', () =>
      runWithGitReadCacheInvalidation(() =>
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
  // Why: Git still owns that path and branch until the background delete finishes; a create now
  // would race it, and the branch cleanup that follows would find the branch checked out again.
  assertNoPendingWorktreeRemovalConflict(repoPath, { worktreePath, branch })
  let pendingLocalBaseRefRefresh: Promise<LocalBaseRefRefreshResult | undefined> | undefined
  let localBaseRefUpdateSuggestion: LocalBaseRefUpdateSuggestion | undefined
  // Why: enable long paths for this Windows checkout without changing user Git config.
  const args = [...windowsLongPathGitArgs(repoPath), 'worktree', 'add']
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
      const baseContext = await resolveWorktreeAddBaseContext(
        repoPath,
        baseBranch,
        refreshLocalBaseRef,
        options,
        branch
      )
      effectiveBase = baseContext.effectiveBase
      pendingLocalBaseRefRefresh = baseContext.pendingLocalBaseRefRefresh
      localBaseRefUpdateSuggestion = baseContext.localBaseRefUpdateSuggestion
      args.push(effectiveBase)
    }
  }
  try {
    await gitExecFileAsync(args, {
      ...gitExecOptions(repoPath, options),
      // Why: resolve per call — hoisting this to a module const would freeze the override at import.
      timeout: resolveWorktreeAddTimeoutMs()
    })
  } catch (error) {
    // Why: settle the overlapped refresh inside the caller's ref-maintenance pause before reporting the failure.
    await pendingLocalBaseRefRefresh
    throw error
  } finally {
    // Git may have written the target's `.git` marker even when it reports a late
    // failure, so drop any pre-create route before the follow-up commands route.
    invalidateWslLinkedWorktreeGitRouting(worktreePath)
  }

  if (options.checkoutExistingBranch) {
    return {}
  }

  if (effectiveBase) {
    await persistWorktreeCreationBase(worktreePath, branch, effectiveBase, options)
  }

  // SSH parity: relay's addWorktreeOp (src/relay/git-handler-worktree-ops.ts) mirrors this — change both in lockstep.
  // Why: --no-track leaves no upstream until first push; push.autoSetupRemote=true lets a plain
  // `git push` create+set origin/<branch> (git >=2.37; older clients ignore it). `--local` on a
  // linked worktree writes the shared common-dir config (whole repo) — intentional and idempotent,
  // so it's warn-only and not rolled back on failure.
  await configurePushAutoSetupRemote(worktreePath, options)
  const localBaseRefRefresh = await pendingLocalBaseRefRefresh
  return {
    ...(localBaseRefRefresh ? { localBaseRefRefresh } : {}),
    ...(localBaseRefUpdateSuggestion ? { localBaseRefUpdateSuggestion } : {})
  }
}
