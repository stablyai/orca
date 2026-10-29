import { GitCommandTimeoutError } from '../../shared/git-command-timeout'
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
import {
  gitExecOptions,
  resolveWorktreeAddTimeoutMs,
  worktreeAddTimeoutMessage
} from './worktree-operation-options'
import { bumpWorktreeScanGeneration } from './worktree-scan-cache'
import { assertNoPendingWorktreeRemovalConflict } from '../worktree-removal-table'
import { createWorktreeCheckoutProgressReader } from './worktree-checkout-progress'

export type WorktreeAddBaseContext = Pick<AddWorktreeResult, 'localBaseRefUpdateSuggestion'> & {
  effectiveBase: string
  effectiveBaseOid?: string
  /** Never rejects; refresh can overlap creation from the remote-tracking commit. */
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
  // -b rejects existing branches; refreshing the branch it creates would race its own ref write.
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
          // An advisory refresh must not fail a checkout that may already have succeeded.
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
      // Clear stale lineage if replacing reused branch metadata fails.
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
    // Honor explicit config at any scope.
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
  } catch {}
}

/** Track a same-name remote base; other newly created branches stay untracked. */
export async function trackSameNameRemoteBase(
  worktreePath: string,
  branch: string,
  baseBranch: string,
  effectiveBase: string,
  options: AddWorktreeOptions
): Promise<boolean> {
  if (!effectiveBase.startsWith('refs/remotes/')) {
    return false
  }
  const parsed = parseRemoteTrackingLocalBaseRef(
    baseBranch,
    effectiveBase,
    options.remoteTrackingBase
  )
  if (parsed?.localBranch !== branch) {
    return false
  }
  try {
    // Git 1.8+ resolves slash-containing remote names via fetch refspecs without another probe.
    await gitExecFileAsync(['branch', '--set-upstream-to', effectiveBase, branch], {
      ...gitExecOptions(worktreePath, options)
    })
    return true
  } catch (error) {
    console.warn(`addWorktree: failed to track ${effectiveBase} for ${branch}`, error)
    return false
  }
}

/** Create a worktree; new branches record base lineage and may enable repo-wide push.autoSetupRemote. */
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
  // Wait for background removal ownership to end before reusing its path or branch.
  assertNoPendingWorktreeRemovalConflict(repoPath, { worktreePath, branch })
  let pendingLocalBaseRefRefresh: Promise<LocalBaseRefRefreshResult | undefined> | undefined
  let localBaseRefUpdateSuggestion: LocalBaseRefUpdateSuggestion | undefined
  const args = [...windowsLongPathGitArgs(repoPath), 'worktree', 'add']
  let effectiveBase: string | undefined
  if (options.trackRemoteBranch && !baseBranch) {
    throw new Error('Reuse branch requires a remote-tracking ref when the local branch is missing.')
  }
  if (noCheckout) {
    args.push('--no-checkout')
  }
  if (options.checkoutExistingBranch) {
    args.push(worktreePath, branch)
  } else {
    // Avoid inheriting the base's upstream; same-name remote bases are tracked explicitly afterward.
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
      if (options.trackRemoteBranch && !effectiveBase.startsWith('refs/remotes/')) {
        throw new Error(
          'Reuse branch requires a remote-tracking ref when the local branch is missing.'
        )
      }
      pendingLocalBaseRefRefresh = baseContext.pendingLocalBaseRefRefresh
      localBaseRefUpdateSuggestion = baseContext.localBaseRefUpdateSuggestion
      args.push(effectiveBase)
    }
  }
  // Read Git's existing stderr meter without requesting extra progress output.
  const checkoutProgress =
    options.onCheckoutProgress && !noCheckout
      ? createWorktreeCheckoutProgressReader(options.onCheckoutProgress)
      : null
  try {
    await gitExecFileAsync(args, {
      ...gitExecOptions(repoPath, options),
      // Resolve per call so later environment overrides take effect.
      timeout: resolveWorktreeAddTimeoutMs(),
      ...(checkoutProgress ? { onStderr: checkoutProgress.read } : {})
    })
  } catch (error) {
    // Settle the refresh before leaving the caller's maintenance pause on failure.
    await pendingLocalBaseRefRefresh
    if (error instanceof GitCommandTimeoutError) {
      error.message = worktreeAddTimeoutMessage(error.timeoutMs)
    }
    throw error
  } finally {
    checkoutProgress?.close()
    // Even late failures can rewrite .git; invalidate pre-create routing before follow-up commands.
    invalidateWslLinkedWorktreeGitRouting(worktreePath)
  }

  if (options.checkoutExistingBranch) {
    return {}
  }

  let upstreamWarning: string | undefined
  if (effectiveBase && baseBranch) {
    await persistWorktreeCreationBase(worktreePath, branch, effectiveBase, options)
    const tracked = await trackSameNameRemoteBase(
      worktreePath,
      branch,
      baseBranch,
      effectiveBase,
      options
    )
    if (options.trackRemoteBranch && !tracked) {
      upstreamWarning = `Could not set ${effectiveBase} as the upstream of "${branch}". Check the push destination before pushing; Git may use a different remote.`
    }
  }

  // Git >= 2.37 can set an upstream on first push; --local intentionally writes shared repo config.
  await configurePushAutoSetupRemote(worktreePath, options)
  const localBaseRefRefresh = await pendingLocalBaseRefRefresh
  return {
    ...(localBaseRefRefresh ? { localBaseRefRefresh } : {}),
    ...(upstreamWarning ? { upstreamWarning } : {}),
    ...(localBaseRefUpdateSuggestion ? { localBaseRefUpdateSuggestion } : {})
  }
}
