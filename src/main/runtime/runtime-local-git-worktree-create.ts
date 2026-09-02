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
import { hasLocalWorktreeBaseRef } from '../git/worktree-base-ref-probe'
import { isGeneratedWorktreeCreateName } from '../worktree-create-candidates'
import { consumePreparedWorktreeCreate } from '../worktree-create-preparation'
import {
  failedWorktreeCreationNeedsRetirement,
  retireGeneratedWorktreeName
} from '../worktree-name-retirement'

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
  baseBranch: string
  workspaceRoot: string
  branchName: string
  worktreePath: string
  effectiveSanitizedName?: string
  checkoutExistingBranch: boolean
  localWorktreeGitOptions: { wslDistro?: string }
  hasLocalWorktreeGitOptions: boolean
  localWorktreeGitOptionArgs: [] | [{ wslDistro?: string }]
  resolveRemoteTrackingBase: (
    repoPath: string,
    baseBranch: string,
    ...options: [] | [{ wslDistro?: string }]
  ) => Promise<RemoteTrackingBase | null>
  hasRemoteTrackingRef: (
    repoPath: string,
    base: RemoteTrackingBase,
    ...options: [] | [{ wslDistro?: string }]
  ) => Promise<boolean>
  refreshRemoteTrackingBase: (
    repoPath: string,
    base: RemoteTrackingBase,
    ...options: [] | [{ wslDistro?: string }]
  ) => Promise<RemoteFetchResult>
  fetchRemote: (
    repoPath: string,
    remote: string,
    ...options: [] | [{ wslDistro?: string }]
  ) => Promise<void>
}): Promise<{
  remoteTrackingBase: RemoteTrackingBase | null
  sparseDirectories: string[]
  configuredPushTarget?: GitPushTarget
  created: GitWorktreeInfo
  addResult: AddWorktreeResult
}> {
  let remoteTrackingBase = await args.resolveRemoteTrackingBase(
    args.repo.path,
    args.baseBranch,
    ...args.localWorktreeGitOptionArgs
  )
  if (remoteTrackingBase) {
    const [hadRemoteRef, hasNamedLocalBaseRef] = await Promise.all([
      args.hasRemoteTrackingRef(
        args.repo.path,
        remoteTrackingBase,
        ...args.localWorktreeGitOptionArgs
      ),
      hasLocalWorktreeBaseRef(
        args.repo.path,
        args.baseBranch,
        args.hasLocalWorktreeGitOptions ? args.localWorktreeGitOptions : {}
      )
    ])
    const hasLocalBase = hadRemoteRef || hasNamedLocalBaseRef
    if (!hadRemoteRef && hasLocalBase) {
      remoteTrackingBase = null
    } else {
      const refresh = await args.refreshRemoteTrackingBase(
        args.repo.path,
        remoteTrackingBase,
        ...args.localWorktreeGitOptionArgs
      )
      if (!refresh.ok && !hadRemoteRef) {
        throw new Error(
          `Could not refresh base ref "${args.baseBranch}" from "${remoteTrackingBase.remote}". Check your network and try again.`
        )
      }
      if (
        !hadRemoteRef &&
        !(await args.hasRemoteTrackingRef(
          args.repo.path,
          remoteTrackingBase,
          ...args.localWorktreeGitOptionArgs
        ))
      ) {
        throw new Error(`Base ref "${args.baseBranch}" was not found after fetching.`)
      }
    }
  } else if (
    !(await hasLocalWorktreeBaseRef(
      args.repo.path,
      args.baseBranch,
      args.hasLocalWorktreeGitOptions ? args.localWorktreeGitOptions : {}
    ))
  ) {
    try {
      await args.fetchRemote(args.repo.path, 'origin', ...args.localWorktreeGitOptionArgs)
    } catch {}
  }
  const sparseDirectories = args.request.sparseCheckout
    ? normalizeSparseDirectories(args.request.sparseCheckout.directories)
    : []
  if (args.request.sparseCheckout && sparseDirectories.length === 0) {
    throw new Error('Sparse checkout requires at least one repo-relative directory.')
  }
  // Why: defer the remote add + fetch (fork case) or the redundant re-fetch
  // (same-repo case, already fetched while resolving the PR start point) to
  // first use -- push/pull/fetch/fast-forward materialize it on demand
  // (#17828). Metadata is persisted untouched; only the git mutation defers.
  const preparedPushTarget = args.request.pushTarget
  const suggestLocalBaseRefUpdate =
    !args.settings.refreshLocalBaseRefOnWorktreeCreate &&
    !args.settings.localBaseRefSuggestionDismissed &&
    Boolean(remoteTrackingBase)
  const remoteOption = remoteTrackingBase ? { remoteTrackingBase } : undefined
  const baseOptions: AddWorktreeOptions | undefined = args.checkoutExistingBranch
    ? {
        checkoutExistingBranch: true,
        ...remoteOption,
        ...(suggestLocalBaseRefUpdate ? { suggestLocalBaseRefUpdate } : {})
      }
    : suggestLocalBaseRefUpdate
      ? { ...remoteOption, suggestLocalBaseRefUpdate }
      : remoteOption
  const addProjectGitOptions = (options?: AddWorktreeOptions): AddWorktreeOptions | undefined =>
    args.hasLocalWorktreeGitOptions ? { ...options, ...args.localWorktreeGitOptions } : options
  const addOptions = addProjectGitOptions(baseOptions)
  const defaultAddWorktreeOption = addProjectGitOptions()
  const preparedWorktreeOptions = suggestLocalBaseRefUpdate
    ? addProjectGitOptions({ ...remoteOption, suggestLocalBaseRefUpdate })
    : remoteOption
      ? addProjectGitOptions(remoteOption)
      : defaultAddWorktreeOption
  const shouldRetireGeneratedName =
    args.request.nameWasGenerated === true &&
    Boolean(args.effectiveSanitizedName) &&
    isGeneratedWorktreeCreateName(args.effectiveSanitizedName!)
  const addStandardWorktree = async (): Promise<AddWorktreeResult> =>
    addOptions
      ? ((await addWorktree(
          args.repo.path,
          args.worktreePath,
          args.branchName,
          args.baseBranch,
          args.settings.refreshLocalBaseRefOnWorktreeCreate,
          false,
          addOptions
        )) ?? {})
      : ((await addWorktree(
          args.repo.path,
          args.worktreePath,
          args.branchName,
          args.baseBranch,
          args.settings.refreshLocalBaseRefOnWorktreeCreate
        )) ?? {})
  let addResult: AddWorktreeResult
  try {
    const preparedAttempt =
      sparseDirectories.length === 0 && !args.checkoutExistingBranch
        ? await consumePreparedWorktreeCreate({
            repoPath: args.repo.path,
            workspaceRoot: args.workspaceRoot,
            worktreePath: args.worktreePath,
            branch: args.branchName,
            baseBranch: args.baseBranch,
            refreshLocalBaseRef: args.settings.refreshLocalBaseRefOnWorktreeCreate,
            ...(preparedWorktreeOptions ? { options: preparedWorktreeOptions } : {})
          })
        : null
    // This path has no create-span recorder, so the miss reason is only observable on the IPC path.
    if (preparedAttempt?.status === 'hit') {
      addResult = preparedAttempt.result
    } else if (sparseDirectories.length > 0) {
      addResult =
        (await (addOptions
          ? addSparseWorktree(
              args.repo.path,
              args.worktreePath,
              args.branchName,
              sparseDirectories,
              args.baseBranch,
              args.settings.refreshLocalBaseRefOnWorktreeCreate,
              addOptions
            )
          : addSparseWorktree(
              args.repo.path,
              args.worktreePath,
              args.branchName,
              sparseDirectories,
              args.baseBranch,
              args.settings.refreshLocalBaseRefOnWorktreeCreate
            ))) ?? {}
    } else {
      addResult = await addStandardWorktree()
    }
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
  if (shouldRetireGeneratedName) {
    await retireGeneratedWorktreeName(
      args.store as Parameters<typeof retireGeneratedWorktreeName>[0],
      args.repo,
      args.settings,
      args.effectiveSanitizedName!
    )
  }
  // Why: `--set-upstream-to` requires the remote to already exist -- safe for a
  // same-repo target (its remote, e.g. `origin`, always exists) but not for a
  // deferred fork remote, which is materialized lazily at first push/pull/fetch.
  const configuredPushTarget =
    preparedPushTarget && !preparedPushTarget.remoteUrl
      ? await configureCreatedWorktreePushTarget(
          args.worktreePath,
          args.branchName,
          preparedPushTarget,
          args.localWorktreeGitOptions
        )
      : preparedPushTarget
  const { created } = await resolveCreatedWorktree(
    args.repo.path,
    args.worktreePath,
    args.branchName,
    args.hasLocalWorktreeGitOptions ? args.localWorktreeGitOptions : undefined
  )
  return {
    remoteTrackingBase,
    sparseDirectories,
    ...(configuredPushTarget ? { configuredPushTarget } : {}),
    created,
    addResult
  }
}
