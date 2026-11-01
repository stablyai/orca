import type { GitPushTarget } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import { isFolderRepo } from '../../shared/repo-kind'
import { requireRepoLocalGitRoute } from '../repo-execution-host'
import { fetchCompareBaseRefWithLocalFallback } from '../git/compare-base-ref-fetch'
import { gitExecFileAsync } from '../git/runner'
import { getDefaultRemote } from '../git/repo'
import { REVIEW_HEAD_FETCH_TIMEOUT_MS } from '../../shared/review-head-tracking-ref'
import { getGiteaRepoRefForRemote } from '../gitea/repository-ref'
import { getGiteaWorkItemDetails } from '../gitea/work-item-details'
import { fetchGiteaPullRequestHeadRef } from '../gitea/pr-head-tracking-ref'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import type { ProjectRuntimeResolutionStore } from '../local-project-runtime-resolution'
import { reviewStartPointFailure } from '../../shared/review-start-point-failure-copy'
import { resolvePrStartPointUnlessWslStopped } from '../github/pr-start-point-wsl-gate'

export type RuntimeGiteaWorktreeBaseArgs = {
  repoSelector: string
  prNumber: number
  headRefName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  /** The user creating from the PR: it may start a stopped WSL distro. */
  wakeWslDistro?: boolean
}

type RuntimeGiteaWorktreeBaseResult =
  | { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget }
  | { error: string }

type LocalGitExecOptions = ReturnType<typeof getLocalProjectGitExecOptions>
type LocalWorktreeGitOptions = ReturnType<typeof getLocalProjectWorktreeGitOptions>

export async function resolveRuntimeGiteaWorktreeBase(
  args: RuntimeGiteaWorktreeBaseArgs,
  deps: {
    store: ProjectRuntimeResolutionStore | null
    resolveRepo: (selector: string) => Promise<Repo>
  }
): Promise<RuntimeGiteaWorktreeBaseResult> {
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
  requireRepoLocalGitRoute(repo)
  const localGitExecOptions = getLocalProjectGitExecOptions(deps.store, repo)
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(deps.store, repo)
  return resolvePrStartPointUnlessWslStopped(
    { path: repo.path, wslDistro: localGitExecOptions.wslDistro },
    { wakeWslDistro: args.wakeWslDistro },
    () => resolveGiteaPrBaseInRepo(repo, args, localGitExecOptions, localWorktreeGitOptions)
  )
}

async function resolveGiteaSourceRemote(
  repo: Repo,
  localGitOptions: LocalWorktreeGitOptions
): Promise<string> {
  const preference = repo.issueSourcePreference
  const candidates = preference === 'origin' ? ['origin'] : ['upstream', 'origin']
  for (const remote of candidates) {
    if (await getGiteaRepoRefForRemote(repo.path, remote, null, localGitOptions)) {
      return remote
    }
  }
  return getDefaultRemote(repo.path, localGitOptions)
}

async function resolveGiteaPrBaseInRepo(
  repo: Repo,
  args: RuntimeGiteaWorktreeBaseArgs,
  localGitExecOptions: LocalGitExecOptions,
  localWorktreeGitOptions: LocalWorktreeGitOptions
): Promise<RuntimeGiteaWorktreeBaseResult> {
  const gitExec = (gitArgs: string[]) => gitExecFileAsync(gitArgs, localGitExecOptions)
  let headBranch = args.headRefName?.trim() ?? ''
  let baseBranch = args.baseRefName?.trim() ?? ''
  let isCrossRepository = args.isCrossRepository === true
  if (!headBranch) {
    const details = await getGiteaWorkItemDetails(
      repo.path,
      args.prNumber,
      'pr',
      repo.issueSourcePreference,
      null,
      null,
      localWorktreeGitOptions
    )
    if (!details || details.item.type !== 'pr') {
      return reviewStartPointFailure('gitea.prNotFound', { number: args.prNumber })
    }
    headBranch = (details.item.branchName ?? '').trim()
    baseBranch = (details.item.baseRefName ?? '').trim()
    isCrossRepository = details.item.isCrossRepository === true
    if (!headBranch) {
      return reviewStartPointFailure('gitea.prHeadBranchMissing', { number: args.prNumber })
    }
  }
  let remote: string
  try {
    remote = await resolveGiteaSourceRemote(repo, localWorktreeGitOptions)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
  }
  const compareBaseRef = baseBranch ? `refs/remotes/${remote}/${baseBranch}` : undefined
  const fetchRemoteTrackingRef = async (branch: string, ref: string): Promise<void> => {
    await gitExecFileAsync(['fetch', remote, `+refs/heads/${branch}:${ref}`], {
      ...localGitExecOptions,
      timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS
    })
  }
  const fetchCompareBaseRef = (): Promise<boolean> =>
    fetchCompareBaseRefWithLocalFallback({
      compareBaseRef,
      fetchCompareBaseRef: (ref) => fetchRemoteTrackingRef(baseBranch, ref),
      gitExec,
      logLabel: '[runtime:resolveManagedGiteaPrBase]',
      logContext: { remote, baseBranch, prNumber: args.prNumber }
    })
  if (isCrossRepository) {
    return resolveGiteaForkPrBase({
      repo,
      remote,
      prNumber: args.prNumber,
      localGitExecOptions,
      gitExec,
      fetchCompareBaseRef,
      compareBaseRef
    })
  }
  const remoteRef = `${remote}/${headBranch}`
  try {
    await fetchRemoteTrackingRef(headBranch, `refs/remotes/${remoteRef}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reviewStartPointFailure('fetchFailed', {
      ref: remoteRef,
      detail: message.split('\n')[0]
    })
  }
  try {
    await gitExec(['rev-parse', '--verify', remoteRef])
  } catch {
    return reviewStartPointFailure('remoteRefMissing', { ref: remoteRef })
  }
  const compareBaseFetched = await fetchCompareBaseRef()
  return {
    baseBranch: remoteRef,
    ...(compareBaseFetched ? { compareBaseRef } : {}),
    pushTarget: { remoteName: remote, branchName: headBranch }
  }
}

async function resolveGiteaForkPrBase(args: {
  repo: Repo
  remote: string
  prNumber: number
  localGitExecOptions: LocalGitExecOptions
  gitExec: (gitArgs: string[]) => Promise<{ stdout: string }>
  fetchCompareBaseRef: () => Promise<boolean>
  compareBaseRef?: string
}): Promise<RuntimeGiteaWorktreeBaseResult> {
  try {
    const localRef = await fetchGiteaPullRequestHeadRef(args.repo, args.remote, args.prNumber, {
      localGitExecOptions: args.localGitExecOptions
    })
    const { stdout } = await args.gitExec(['rev-parse', '--verify', `${localRef}^{commit}`])
    const sha = stdout.trim()
    if (!sha) {
      return reviewStartPointFailure('gitea.forkHeadUnresolved', { number: args.prNumber })
    }
    const compareBaseFetched = await args.fetchCompareBaseRef()
    return {
      baseBranch: sha,
      ...(compareBaseFetched ? { compareBaseRef: args.compareBaseRef } : {})
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reviewStartPointFailure('fetchFailed', {
      ref: `refs/pull/${args.prNumber}/head`,
      detail: message.split('\n')[0]
    })
  }
}
