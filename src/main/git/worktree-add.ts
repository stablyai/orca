import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'
import type { LocalBaseRefRefreshResult } from '../../shared/worktree/base-ref-drift-types'
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
import type { AddWorktreeOptions, AddWorktreeResult } from './worktree-operation-options'
import { gitExecOptions, resolveWorktreeAddTimeoutMs } from './worktree-operation-options'
import { bumpWorktreeScanGeneration } from './worktree-scan-cache'
import { assertNoPendingWorktreeRemovalConflict } from '../worktree-background-removal'
import { spareRepoKey } from '../worktree-create-preparation-pool'
import { recordPlainAddDuration } from '../worktree-create-spare-gate'
import type { PreparedCheckoutOutcome } from '../../shared/worktree/create-types'
import {
  configurePushAutoSetupRemote,
  persistWorktreeCreationBase
} from './worktree-add-creation-config'
import { createFromReadySpare } from './worktree-spare-handover'

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
  // A spare claim comes after this too, so a refused create leaves the spare where it was.
  assertNoPendingWorktreeRemovalConflict(repoPath, { worktreePath, branch })
  // Why: enable long paths for this Windows checkout without changing user Git config.
  const args = [...windowsLongPathGitArgs(repoPath), 'worktree', 'add']
  let baseContext: WorktreeAddBaseContext | undefined
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
      baseContext = await resolveWorktreeAddBaseContext(
        repoPath,
        baseBranch,
        refreshLocalBaseRef,
        options,
        branch
      )
      args.push(baseContext.effectiveBase)
    }
  }
  const pendingLocalBaseRefRefresh = baseContext?.pendingLocalBaseRefRefresh
  let preparedCheckout: PreparedCheckoutOutcome | undefined
  try {
    preparedCheckout = await addFromSpareOrGit(args, {
      repoPath,
      worktreePath,
      branch,
      noCheckout,
      baseContext,
      options
    })
  } catch (error) {
    // Why: settle the overlapped refresh inside the caller's ref-maintenance pause before reporting the failure.
    await pendingLocalBaseRefRefresh
    throw error
  }
  if (options.checkoutExistingBranch) {
    return preparedCheckout ? { preparedCheckout } : {}
  }
  if (preparedCheckout?.status !== 'hit') {
    if (baseContext) {
      await persistWorktreeCreationBase(worktreePath, branch, baseContext.effectiveBase, options)
    }
    // SSH parity: relay's addWorktreeOp (src/relay/git-handler-worktree-ops.ts) mirrors this — change both in lockstep.
    // Why: --no-track leaves no upstream until first push; push.autoSetupRemote=true lets a plain
    // `git push` create+set origin/<branch> (git >=2.37; older clients ignore it). `--local` on a
    // linked worktree writes the shared common-dir config (whole repo) — intentional and idempotent,
    // so it's warn-only and not rolled back on failure.
    await configurePushAutoSetupRemote(worktreePath, options)
  }
  const localBaseRefRefresh = await pendingLocalBaseRefRefresh
  const localBaseRefUpdateSuggestion = baseContext?.localBaseRefUpdateSuggestion
  return {
    ...(localBaseRefRefresh ? { localBaseRefRefresh } : {}),
    ...(localBaseRefUpdateSuggestion ? { localBaseRefUpdateSuggestion } : {}),
    ...(preparedCheckout ? { preparedCheckout } : {})
  }
}

/** Uses a ready spare when the caller opted in, and otherwise runs the plain `git worktree add`. */
async function addFromSpareOrGit(
  args: string[],
  add: {
    repoPath: string
    worktreePath: string
    branch: string
    noCheckout: boolean
    baseContext: WorktreeAddBaseContext | undefined
    options: AddWorktreeOptions
  }
): Promise<PreparedCheckoutOutcome | undefined> {
  const { repoPath, worktreePath, options, baseContext } = add
  const optedIn = options.preparedCheckout
  let outcome: PreparedCheckoutOutcome | undefined
  // A spare is a full detached checkout: never for an existing branch or a sparse (no-checkout) add.
  if (optedIn && baseContext && !add.noCheckout && !options.checkoutExistingBranch) {
    outcome = await createFromReadySpare({
      repoPath,
      worktreePath,
      branch: add.branch,
      effectiveBase: baseContext.effectiveBase,
      ...(baseContext.effectiveBaseOid ? { effectiveBaseOid: baseContext.effectiveBaseOid } : {}),
      workspaceRoot: optedIn.workspaceRoot,
      options
    })
  }
  if (outcome?.status === 'hit') {
    return outcome
  }
  const startedAt = Date.now()
  try {
    await gitExecFileAsync(args, {
      ...gitExecOptions(repoPath, options),
      // Why: resolve per call — hoisting this to a module const would freeze the override at import.
      timeout: resolveWorktreeAddTimeoutMs()
    })
  } finally {
    // Git may have written the target's `.git` marker even when it reports a late
    // failure, so drop any pre-create route before the follow-up commands route.
    invalidateWslLinkedWorktreeGitRouting(worktreePath)
    // Only the `worktree add` child, success or failure. Git runs post-checkout inside it, so a
    // slow hook still counts; nothing outside the child can be told apart from it.
    if (!add.noCheckout) {
      recordPlainAddDuration(spareRepoKey(repoPath, options.wslDistro), Date.now() - startedAt)
    }
  }
  return outcome
}
