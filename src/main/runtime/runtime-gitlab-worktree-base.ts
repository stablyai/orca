import type { GitPushTarget } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import { isFolderRepo } from '../../shared/repo-kind'
import { requireRepoLocalGitRoute } from '../repo-execution-host'
import { fetchCompareBaseRefWithLocalFallback } from '../git/compare-base-ref-fetch'
import { gitExecFileAsync } from '../git/runner'
import { REVIEW_HEAD_FETCH_TIMEOUT_MS } from '../../shared/review-head-tracking-ref'
import { getProjectRefForRemote, getWorkItemByProjectRef } from '../gitlab/client'
import { getGlabKnownHosts } from '../gitlab/gl-utils'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import type { ProjectRuntimeResolutionStore } from '../local-project-runtime-resolution'
import { resolveRuntimeGitLabForkMrBase } from './runtime-gitlab-fork-mr-base'
import { resolveRuntimeGitLabIssueSourceRemote } from './runtime-gitlab-issue-source-remote'
import { reviewStartPointFailure } from '../../shared/review-start-point-failure-copy'
import { resolvePrStartPointUnlessWslStopped } from '../github/pr-start-point-wsl-gate'

export type RuntimeGitLabWorktreeBaseArgs = {
  repoSelector: string
  mrIid: number
  sourceBranch?: string
  targetBranch?: string
  isCrossRepository?: boolean
  /** The user creating from the MR: it may start a stopped WSL distro. */
  wakeWslDistro?: boolean
}

type RuntimeGitLabWorktreeBaseResult =
  | { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget }
  | { error: string }

export async function resolveRuntimeGitLabWorktreeBase(
  args: RuntimeGitLabWorktreeBaseArgs,
  deps: {
    store: ProjectRuntimeResolutionStore | null
    resolveRepo: (selector: string) => Promise<Repo>
  }
): Promise<RuntimeGitLabWorktreeBaseResult> {
  if (!deps.store) {
    throw new Error('runtime_unavailable')
  }
  let repo: Repo
  try {
    repo = await deps.resolveRepo(args.repoSelector)
  } catch {
    return reviewStartPointFailure('repoNotFound')
  }
  if (isFolderRepo(repo)) {
    return reviewStartPointFailure('folderUnsupported')
  }
  // Use shared host gating: executionHostId may be a row's only SSH marker.
  requireRepoLocalGitRoute(repo)
  const localGitExecOptions = getLocalProjectGitExecOptions(deps.store, repo)
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(deps.store, repo)
  // Source Control's push-target ensure asks unprompted; it must not start a stopped distro (E9).
  return resolvePrStartPointUnlessWslStopped(
    { path: repo.path, wslDistro: localGitExecOptions.wslDistro },
    { wakeWslDistro: args.wakeWslDistro },
    () => resolveGitLabMrBaseInRepo(repo, args, localGitExecOptions, localWorktreeGitOptions)
  )
}

async function resolveGitLabMrBaseInRepo(
  repo: Repo,
  args: RuntimeGitLabWorktreeBaseArgs,
  localGitExecOptions: ReturnType<typeof getLocalProjectGitExecOptions>,
  localWorktreeGitOptions: ReturnType<typeof getLocalProjectWorktreeGitOptions>
): Promise<RuntimeGitLabWorktreeBaseResult> {
  const gitExec = (gitArgs: string[]) => gitExecFileAsync(gitArgs, localGitExecOptions)
  let sourceBranch = args.sourceBranch?.trim() ?? ''
  let targetBranch = args.targetBranch?.trim() ?? ''
  let isCrossRepository = args.isCrossRepository === true
  if (!sourceBranch) {
    let discoveryRemote: string
    try {
      discoveryRemote = await resolveRuntimeGitLabIssueSourceRemote(
        repo.path,
        repo.issueSourcePreference,
        localWorktreeGitOptions
      )
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
    }
    const knownHosts = await getGlabKnownHosts(null, localWorktreeGitOptions)
    const projectRef = await getProjectRefForRemote(
      repo.path,
      discoveryRemote,
      knownHosts,
      null,
      localWorktreeGitOptions
    )
    if (!projectRef) {
      return reviewStartPointFailure('gitlab.projectNotFound')
    }
    const item = await getWorkItemByProjectRef(
      repo.path,
      projectRef,
      args.mrIid,
      'mr',
      null,
      localWorktreeGitOptions
    )
    if (!item || item.type !== 'mr') {
      return reviewStartPointFailure('gitlab.mrNotFound', { number: args.mrIid })
    }
    sourceBranch = (item.branchName ?? '').trim()
    targetBranch = (item.baseRefName ?? '').trim()
    if (!sourceBranch) {
      return reviewStartPointFailure('gitlab.mrSourceBranchMissing', { number: args.mrIid })
    }
    if (item.isCrossRepository === true) {
      isCrossRepository = true
    }
  }
  let remote: string
  try {
    remote = await resolveRuntimeGitLabIssueSourceRemote(
      repo.path,
      repo.issueSourcePreference,
      localWorktreeGitOptions
    )
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
  }
  const compareBaseRef = targetBranch ? `refs/remotes/${remote}/${targetBranch}` : undefined
  const fetchRemoteTrackingRef = async (branch: string, ref: string): Promise<void> => {
    await gitExecFileAsync(['fetch', remote, `+refs/heads/${branch}:${ref}`], {
      ...localGitExecOptions,
      timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS
    })
  }
  const fetchCompareBaseRef = (): Promise<boolean> =>
    fetchCompareBaseRefWithLocalFallback({
      compareBaseRef,
      fetchCompareBaseRef: (ref) => fetchRemoteTrackingRef(targetBranch, ref),
      gitExec,
      logLabel: '[runtime:resolveManagedMrBase]',
      logContext: { remote, targetBranch, mrIid: args.mrIid }
    })
  if (isCrossRepository) {
    return resolveRuntimeGitLabForkMrBase({
      repo,
      remote,
      mrIid: args.mrIid,
      localGitExecOptions,
      gitExec,
      fetchCompareBaseRef,
      compareBaseRef
    })
  }
  try {
    await fetchRemoteTrackingRef(sourceBranch, `refs/remotes/${remote}/${sourceBranch}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reviewStartPointFailure('fetchFailed', {
      ref: `${remote}/${sourceBranch}`,
      detail: message.split('\n')[0]
    })
  }
  const remoteRef = `${remote}/${sourceBranch}`
  try {
    await gitExec(['rev-parse', '--verify', remoteRef])
  } catch {
    return reviewStartPointFailure('remoteRefMissing', { ref: remoteRef })
  }
  const compareBaseFetched = await fetchCompareBaseRef()
  return {
    baseBranch: remoteRef,
    ...(compareBaseFetched ? { compareBaseRef } : {}),
    pushTarget: { remoteName: remote, branchName: sourceBranch }
  }
}
