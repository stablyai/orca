import type { LocalGitExecOptions } from '../git/repo-default-base-ref'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'
import type { GitPushTarget, GitWorktreeInfo } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import { resolveCreatedWorktree } from '../ipc/created-worktree-reconciliation'
import { normalizeSparseDirectories } from '../ipc/sparse-checkout-directories'
import { configureCreatedWorktreePushTarget } from '../ipc/worktree-remote'
import {
  addSparseWorktree,
  addWorktree,
  type AddWorktreeOptions,
  type AddWorktreeResult
} from '../git/worktree'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'
import type { RuntimeLocalWorktreeCreateBase } from './runtime-local-worktree-create-base'
import { isGeneratedWorktreeCreateName } from '../worktree-create-candidates'
import {
  consumePreparedWorktreeCreate,
  type PreparationRearmHolder
} from '../worktree-create-preparation'
import {
  failedWorktreeCreationNeedsRetirement,
  retireGeneratedWorktreeName
} from '../worktree-name-retirement'
import type { WorktreeCreateTimingRecorder } from '../worktree-create-timing'

export type RuntimeLocalBaseRefRefresh = {
  /** Awaits the deferred refresh started before naming, if any. */
  finish: () => Promise<void>
}

// Refresh cannot change base/name; overlap it with naming's PR lookup, then await before add as desktop does.
export function startRuntimeLocalBaseRefRefresh(args: {
  repoPath: string
  base: RuntimeLocalWorktreeCreateBase
  localWorktreeGitOptions: LocalGitExecOptions
  refreshRemoteTrackingBase: (
    repoPath: string,
    base: RemoteTrackingBase,
    options?: LocalGitExecOptions
  ) => Promise<RemoteFetchResult>
  fetchRemote: (repoPath: string, remote: string, options?: LocalGitExecOptions) => Promise<void>
  timing: WorktreeCreateTimingRecorder
}): RuntimeLocalBaseRefRefresh {
  const { remoteTrackingBase, deferredRefresh } = args.base
  if (remoteTrackingBase && deferredRefresh === 'tracking_ref') {
    const refresh = args.refreshRemoteTrackingBase(
      args.repoPath,
      remoteTrackingBase,
      args.localWorktreeGitOptions
    )
    // Handle refresh rejection even if naming throws before finish awaits it.
    void refresh.catch(() => undefined)
    return {
      finish: async () => {
        await args.timing.time('refresh_base_ref', () => refresh)
      }
    }
  }
  if (deferredRefresh === 'origin') {
    const originFetch = args.fetchRemote(args.repoPath, 'origin', args.localWorktreeGitOptions)
    void originFetch.catch(() => undefined)
    return {
      finish: async () => {
        try {
          await args.timing.time('refresh_base_ref', () => originFetch)
        } catch {}
      }
    }
  }
  return { finish: async () => {} }
}

export async function createRuntimeLocalGitWorktree(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  store: RuntimeStore
  settings: {
    workspaceDir: string
    nestWorkspaces: boolean
    refreshLocalBaseRefOnWorktreeCreate: boolean
    localBaseRefSuggestionDismissed?: boolean
  }
  base: RuntimeLocalWorktreeCreateBase
  workspaceRoot: string
  branchName: string
  worktreePath: string
  effectiveSanitizedName?: string
  checkoutExistingBranch: boolean
  localWorktreeGitOptions: LocalGitExecOptions
  baseRefRefresh: RuntimeLocalBaseRefRefresh
  rearm: PreparationRearmHolder
  timing: WorktreeCreateTimingRecorder
}): Promise<{
  sparseDirectories: string[]
  configuredPushTarget?: GitPushTarget
  created: GitWorktreeInfo
  addResult: AddWorktreeResult
}> {
  const { baseBranch, remoteTrackingBase } = args.base
  await args.baseRefRefresh.finish()
  const sparseDirectories = args.request.sparseCheckout
    ? normalizeSparseDirectories(args.request.sparseCheckout.directories)
    : []
  if (args.request.sparseCheckout && sparseDirectories.length === 0) {
    throw new Error('Sparse checkout requires at least one repo-relative directory.')
  }
  // Defer fork remote add/fetch and redundant same-repo fetch until push/pull/fetch/fast-forward; persist metadata unchanged (#17828).
  const preparedPushTarget = args.request.pushTarget
  const suggestLocalBaseRefUpdate =
    !args.settings.refreshLocalBaseRefOnWorktreeCreate &&
    !args.settings.localBaseRefSuggestionDismissed &&
    Boolean(remoteTrackingBase)
  const remoteOption = remoteTrackingBase ? { remoteTrackingBase } : undefined
  const preparedWorktreeOptions: AddWorktreeOptions = {
    ...remoteOption,
    ...(suggestLocalBaseRefUpdate ? { suggestLocalBaseRefUpdate } : {}),
    ...args.localWorktreeGitOptions
  }
  const addOptions: AddWorktreeOptions = {
    ...preparedWorktreeOptions,
    ...(args.checkoutExistingBranch ? { checkoutExistingBranch: true } : {})
  }
  const shouldRetireGeneratedName =
    args.request.nameWasGenerated === true &&
    Boolean(args.effectiveSanitizedName) &&
    isGeneratedWorktreeCreateName(args.effectiveSanitizedName!)
  let addResult: AddWorktreeResult
  try {
    addResult = await args.timing.time('git_worktree_add', async () => {
      if (sparseDirectories.length > 0 || args.checkoutExistingBranch) {
        args.timing.recordPreparedCheckout({
          status: 'miss',
          reason: sparseDirectories.length > 0 ? 'sparse_checkout' : 'checkout_existing_branch'
        })
      } else {
        const preparedAttempt = await consumePreparedWorktreeCreate({
          repoPath: args.repo.path,
          workspaceRoot: args.workspaceRoot,
          worktreePath: args.worktreePath,
          branch: args.branchName,
          baseBranch,
          refreshLocalBaseRef: args.settings.refreshLocalBaseRefOnWorktreeCreate,
          options: preparedWorktreeOptions,
          timing: args.timing
        })
        if (preparedAttempt.status === 'hit') {
          // Return rearm unstarted: reset --hard must wait until materialization and terminal startup finish.
          args.rearm.fire = preparedAttempt.rearm
          return preparedAttempt.result
        }
        if (preparedAttempt.rearm) {
          args.rearm.fire = preparedAttempt.rearm
        }
      }
      if (sparseDirectories.length > 0) {
        return (
          (await addSparseWorktree(
            args.repo.path,
            args.worktreePath,
            args.branchName,
            sparseDirectories,
            baseBranch,
            args.settings.refreshLocalBaseRefOnWorktreeCreate,
            addOptions
          )) ?? {}
        )
      }
      return (
        (await addWorktree(
          args.repo.path,
          args.worktreePath,
          args.branchName,
          baseBranch,
          args.settings.refreshLocalBaseRefOnWorktreeCreate,
          false,
          addOptions
        )) ?? {}
      )
    })
  } catch (error) {
    if (shouldRetireGeneratedName && failedWorktreeCreationNeedsRetirement(error)) {
      await retireGeneratedWorktreeName(
        args.store as Parameters<typeof retireGeneratedWorktreeName>[0],
        args.repo,
        args.settings,
        args.effectiveSanitizedName!
      )
    }
    throw error
  }
  // New worktree is now listable; invalidate scans started before it appeared.
  runWorktreeChangeInvalidators(args.repo.id)
  if (shouldRetireGeneratedName) {
    await retireGeneratedWorktreeName(
      args.store as Parameters<typeof retireGeneratedWorktreeName>[0],
      args.repo,
      args.settings,
      args.effectiveSanitizedName!
    )
  }
  // Set upstream only for existing same-repo remotes; deferred fork remotes materialize at first push/pull/fetch.
  const configuredPushTarget =
    preparedPushTarget && !preparedPushTarget.remoteUrl
      ? await configureCreatedWorktreePushTarget(
          args.worktreePath,
          args.branchName,
          preparedPushTarget,
          args.localWorktreeGitOptions
        )
      : preparedPushTarget
  const { created, worktrees, listingComplete } = await args.timing.time(
    'list_created_worktree',
    () =>
      resolveCreatedWorktree(
        args.repo.path,
        args.worktreePath,
        args.branchName,
        args.localWorktreeGitOptions
      )
  )
  if (listingComplete) {
    args.timing.recordWorktreeCount(worktrees.length)
  }
  return {
    sparseDirectories,
    ...(configuredPushTarget ? { configuredPushTarget } : {}),
    created,
    addResult
  }
}
