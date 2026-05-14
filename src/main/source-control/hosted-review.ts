import type { HostedReviewInfo } from '../../shared/hosted-review'
import type { MRInfo, PRInfo } from '../../shared/types'
import {
  getBitbucketPullRequest,
  getBitbucketPullRequestForBranch,
  getBitbucketRepoSlug
} from '../bitbucket/client'
import type { BitbucketPullRequestInfo } from '../bitbucket/pull-request-mappers'
import {
  getGiteaPullRequest,
  getGiteaPullRequestForBranch,
  getGiteaRepoSlug
} from '../gitea/client'
import type { GiteaPullRequestInfo } from '../gitea/pull-request-mappers'
import { getPRForBranch, getRepoSlug } from '../github/client'
import { getMergeRequest, getMergeRequestForBranch, getProjectSlug } from '../gitlab/client'

function mapGitHubReview(pr: PRInfo): HostedReviewInfo {
  return {
    provider: 'github',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.checksStatus,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.headSha ? { headSha: pr.headSha } : {}),
    ...(pr.conflictSummary ? { conflictSummary: pr.conflictSummary } : {})
  }
}

function mapGitLabReviewState(state: MRInfo['state']): HostedReviewInfo['state'] {
  if (state === 'opened' || state === 'locked') {
    return 'open'
  }
  return state
}

function mapGitLabReview(mr: MRInfo): HostedReviewInfo {
  return {
    provider: 'gitlab',
    number: mr.number,
    title: mr.title,
    state: mapGitLabReviewState(mr.state),
    url: mr.url,
    status: mr.pipelineStatus,
    updatedAt: mr.updatedAt,
    mergeable: mr.mergeable,
    ...(mr.headSha ? { headSha: mr.headSha } : {}),
    ...(mr.conflictSummary ? { conflictSummary: mr.conflictSummary } : {})
  }
}

function mapBitbucketReview(pr: BitbucketPullRequestInfo): HostedReviewInfo {
  return {
    provider: 'bitbucket',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.status,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.headSha ? { headSha: pr.headSha } : {})
  }
}

function mapGiteaReview(pr: GiteaPullRequestInfo): HostedReviewInfo {
  return {
    provider: 'gitea',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.status,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.headSha ? { headSha: pr.headSha } : {})
  }
}

export async function getHostedReviewForBranch(input: {
  repoPath: string
  connectionId?: string | null
  branch: string
  linkedGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedGiteaPR?: number | null
}): Promise<HostedReviewInfo | null> {
  const branchName = input.branch.replace(/^refs\/heads\//, '')
  if (
    !branchName &&
    input.linkedGitHubPR == null &&
    input.linkedGitLabMR == null &&
    input.linkedBitbucketPR == null &&
    input.linkedGiteaPR == null
  ) {
    return null
  }

  // Why: branch review status is tied to the branch publishing remote.
  // GitHub and GitLab task/project surfaces may use richer per-provider
  // source preferences, but this core status should follow origin.
  const gitlabProject = await getProjectSlug(input.repoPath)
  if (gitlabProject) {
    const mr =
      (await getMergeRequestForBranch(input.repoPath, branchName, input.linkedGitLabMR ?? null)) ??
      null
    return mr ? mapGitLabReview(mr) : null
  }

  const githubRepo = await getRepoSlug(input.repoPath, input.connectionId)
  if (githubRepo) {
    const pr = await getPRForBranch(
      input.repoPath,
      branchName,
      input.linkedGitHubPR ?? null,
      input.connectionId
    )
    return pr ? mapGitHubReview(pr) : null
  }

  const bitbucketRepo = await getBitbucketRepoSlug(input.repoPath)
  if (bitbucketRepo) {
    const pr = await getBitbucketPullRequestForBranch(
      input.repoPath,
      branchName,
      input.linkedBitbucketPR ?? null
    )
    return pr ? mapBitbucketReview(pr) : null
  }

  const giteaRepo = await getGiteaRepoSlug(input.repoPath)
  if (giteaRepo) {
    const pr = await getGiteaPullRequestForBranch(
      input.repoPath,
      branchName,
      input.linkedGiteaPR ?? null
    )
    return pr ? mapGiteaReview(pr) : null
  }

  return null
}

export async function getHostedReviewByNumber(input: {
  repoPath: string
  provider: 'github' | 'gitlab' | 'bitbucket' | 'gitea'
  number: number
}): Promise<HostedReviewInfo | null> {
  if (input.provider === 'gitlab') {
    const mr = await getMergeRequest(input.repoPath, input.number)
    return mr ? mapGitLabReview(mr) : null
  }
  if (input.provider === 'bitbucket') {
    const pr = await getBitbucketPullRequest(input.repoPath, input.number)
    return pr ? mapBitbucketReview(pr) : null
  }
  if (input.provider === 'gitea') {
    const pr = await getGiteaPullRequest(input.repoPath, input.number)
    return pr ? mapGiteaReview(pr) : null
  }
  const pr = await getPRForBranch(input.repoPath, '', input.number)
  return pr ? mapGitHubReview(pr) : null
}
