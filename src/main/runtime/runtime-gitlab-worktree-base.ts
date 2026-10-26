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

export type RuntimeGitLabWorktreeBaseArgs = {
  repoSelector: string
  mrIid: number
  sourceBranch?: string
  targetBranch?: string
  isCrossRepository?: boolean
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
    return { error: 'Repo not found' }
  }
  if (isFolderRepo(repo)) {
    return { error: 'Folder mode does not support creating worktrees.' }
  }
  // Use shared host gating: executionHostId may be a row's only SSH marker.
  requireRepoLocalGitRoute(repo)
  const localGitExecOptions = getLocalProjectGitExecOptions(deps.store, repo)
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(deps.store, repo)
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
      return { error: 'No GitLab project found for this repository.' }
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
      return { error: `MR !${args.mrIid} not found.` }
    }
    sourceBranch = (item.branchName ?? '').trim()
    targetBranch = (item.baseRefName ?? '').trim()
    if (!sourceBranch) {
      return { error: `MR !${args.mrIid} has no source branch.` }
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
    return { error: `Failed to fetch ${remote}/${sourceBranch}: ${message.split('\n')[0]}` }
  }
  const remoteRef = `${remote}/${sourceBranch}`
  try {
    await gitExec(['rev-parse', '--verify', remoteRef])
  } catch {
    return { error: `Remote ref ${remoteRef} does not exist after fetch.` }
  }
  const compareBaseFetched = await fetchCompareBaseRef()
  return {
    baseBranch: remoteRef,
    ...(compareBaseFetched ? { compareBaseRef } : {}),
    pushTarget: { remoteName: remote, branchName: sourceBranch }
  }
}
