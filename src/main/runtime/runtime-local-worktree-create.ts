import { worktreeCreateGit } from '../git/worktree-create-git-executor'
import { shouldRunSetupForCreate } from '../effective-hook-config'
import { getEffectiveHooks } from '../hooks'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { Store } from '../persistence'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions,
  getWorktreeMirrorDistro
} from '../project-runtime-git-options'
import { resolveDefaultBaseRefWithLocalGit } from '../git/repo'
import type { LocalGitExecOptions } from '../git/repo-default-base-ref'
import { resolveLocalGitUsername } from '../git/git-username'
import { computeWorkspaceRoot, getWorktreePathSettings } from '../ipc/worktree-logic'
import { resolveWorktreeCreateBase } from '../worktree-create-base'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'
import { hasLocalWorktreeBaseRef } from '../git/worktree-base-ref-probe'
import { resolveRuntimeLocalWorktreeCreateCandidate } from './runtime-local-worktree-create-candidate'
import { createRuntimeLocalGitWorktree } from './runtime-local-git-worktree-create'
import { resolveRuntimeLocalWorktreeCreateBase } from './runtime-local-worktree-create-base'
import { materializeRuntimeLocalWorktree } from './runtime-local-worktree-materialization'
import { resolveRuntimeSetupDecision } from './runtime-local-worktree-setup'
import type { PreparationRearmHolder } from '../worktree-create-preparation'
import {
  localWorktreeCreateExecutionHost,
  type WorktreeCreateTimingRecorder
} from '../worktree-create-timing'

type RuntimeLocalWorktreeCreateArgs<T> = {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  store: Store
  createdWithAgent: RuntimeManagedWorktreeCreateArgs['createdWithAgent']
  hostedReviewExecutionContext?: HostedReviewExecutionOptions
  resolveRemoteTrackingBase: (
    path: string,
    base: string,
    options?: LocalGitExecOptions
  ) => Promise<RemoteTrackingBase | null>
  hasRemoteTrackingRef: (
    path: string,
    base: RemoteTrackingBase,
    options?: LocalGitExecOptions
  ) => Promise<boolean>
  refreshRemoteTrackingBase: (
    path: string,
    base: RemoteTrackingBase,
    options?: LocalGitExecOptions
  ) => Promise<RemoteFetchResult>
  fetchRemote: (path: string, remote: string, options?: LocalGitExecOptions) => Promise<void>
  onWorktreeMetadataPersisted: (worktree: Worktree) => T
  rearm: PreparationRearmHolder
  timing: WorktreeCreateTimingRecorder
}

export function createRuntimeLocalManagedWorktree<T>(args: RuntimeLocalWorktreeCreateArgs<T>) {
  return worktreeCreateGit.run(() => performRuntimeLocalWorktreeCreate(args))
}

async function performRuntimeLocalWorktreeCreate<T>(args: RuntimeLocalWorktreeCreateArgs<T>) {
  const { request, repo, store } = args
  const settings = store.getSettings()
  const pathSettings = getWorktreePathSettings(repo, settings, getWorktreeMirrorDistro(store, repo))
  const gitExecOptions = getLocalProjectGitExecOptions(store, repo)
  const worktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  args.timing.recordExecutionHost(localWorktreeCreateExecutionHost(gitExecOptions))
  // Why before any git work: an `ask` repo with no decision must refuse with nothing created, as
  // the desktop create does; checked after the add, it left an orphan worktree behind.
  if (getEffectiveHooks(repo)?.scripts.setup) {
    shouldRunSetupForCreate(repo, resolveRuntimeSetupDecision(request))
  }
  // Username and base resolution are independent read-only probes. Starting
  // both before awaiting removes one serial git/config round trip from create.
  const usernamePromise =
    !request.branchNameOverride && settings.branchPrefix === 'git-username'
      ? resolveLocalGitUsername(repo.path)
      : Promise.resolve('')
  const baseBranchPromise = resolveWorktreeCreateBase({
    requestedBaseBranch: request.baseBranch,
    repoWorktreeBaseRef: repo.worktreeBaseRef,
    resolveDefaultBaseRef: () => resolveDefaultBaseRefWithLocalGit(gitExecOptions),
    isBaseUsable: async (candidate) => {
      const remoteBase = await args.resolveRemoteTrackingBase(
        repo.path,
        candidate,
        worktreeGitOptions
      )
      if (
        remoteBase &&
        (await args.hasRemoteTrackingRef(repo.path, remoteBase, worktreeGitOptions))
      ) {
        return true
      }
      return hasLocalWorktreeBaseRef(repo.path, candidate, worktreeGitOptions)
    }
  })
  const [username, baseBranch] = await Promise.all([usernamePromise, baseBranchPromise])
  if (!baseBranch) {
    throw new Error(
      'Could not resolve a default base ref for this repo. Pass an explicit --base and try again.'
    )
  }
  const base = await resolveRuntimeLocalWorktreeCreateBase({
    repoPath: repo.path,
    baseBranch,
    localWorktreeGitOptions: worktreeGitOptions,
    allowLocalBaseFallback: request.allowLocalBaseFallback === true,
    resolveRemoteTrackingBase: args.resolveRemoteTrackingBase,
    hasRemoteTrackingRef: args.hasRemoteTrackingRef,
    refreshRemoteTrackingBase: args.refreshRemoteTrackingBase,
    timing: args.timing
  })
  const candidate = await args.timing.time('resolve_name', () =>
    resolveRuntimeLocalWorktreeCreateCandidate({
      request,
      repo,
      settings,
      worktreePathSettings: pathSettings,
      workspaceRoot: computeWorkspaceRoot(repo.path, pathSettings),
      username,
      store,
      baseBranch: base.baseBranch,
      localWorktreeGitOptions: worktreeGitOptions,
      hostedReviewExecutionContext: args.hostedReviewExecutionContext
    })
  )
  const git = await createRuntimeLocalGitWorktree({
    request,
    repo,
    store,
    settings,
    base,
    workspaceRoot: computeWorkspaceRoot(repo.path, pathSettings),
    branchName: candidate.branchName,
    worktreePath: candidate.worktreePath,
    effectiveSanitizedName: candidate.effectiveSanitizedName,
    checkoutExistingBranch: candidate.checkoutExistingBranch,
    localWorktreeGitOptions: worktreeGitOptions,
    refreshRemoteTrackingBase: args.refreshRemoteTrackingBase,
    fetchRemote: args.fetchRemote,
    rearm: args.rearm,
    timing: args.timing
  })
  const materialized = await materializeRuntimeLocalWorktree({
    request,
    repo,
    store,
    settings,
    created: git.created,
    remoteTrackingBase: base.remoteTrackingBase,
    sparseDirectories: git.sparseDirectories,
    configuredPushTarget: git.configuredPushTarget,
    checkoutExistingBranch: candidate.checkoutExistingBranch,
    baseBranch: base.baseBranch,
    branchName: candidate.branchName,
    effectiveRequestedName: candidate.effectiveRequestedName,
    requestedDisplayName: candidate.requestedDisplayName,
    displayNameKind: candidate.displayNameKind,
    effectiveSanitizedName: candidate.effectiveSanitizedName,
    effectiveCreatedWithAgent: args.createdWithAgent,
    localWorktreeGitOptions: worktreeGitOptions,
    onMetadataPersisted: args.onWorktreeMetadataPersisted,
    timing: args.timing
  })
  return {
    ...materialized,
    worktreePath: candidate.worktreePath,
    created: git.created,
    addResult: git.addResult,
    ...(base.baseFallback ? { baseFallback: base.baseFallback } : {})
  }
}
