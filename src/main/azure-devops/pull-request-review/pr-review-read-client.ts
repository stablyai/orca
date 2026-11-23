import type {
  AzureDevOpsPrDetail,
  AzureDevOpsPrSummary
} from '../../../shared/azure-devops/azure-devops-pr-review-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import { resolveAzureDevOpsApiBases } from '../boards/api-bases'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { mapPullRequestSummary, mapReviewers, type RawPullRequest } from './pr-review-mappers'

const PR_READ_TIMEOUT_MS = 15_000
export const AWAITING_REVIEW_LIMIT = 100

export type PullRequestLocation = { collection: string; projectId: string; repositoryId: string }

export async function getAzureDevOpsCurrentUserId(collection: string): Promise<string | null> {
  const data = await requestAzureDevOpsJsonAtBase<{ authenticatedUser?: { id?: string | null } }>(
    collection,
    '/_apis/connectionData',
    { timeoutMs: 5000 },
    true
  )
  return data?.authenticatedUser?.id ?? null
}

/** Active, non-draft PRs across the repo's organization where the signed-in user is a reviewer. */
export async function listAzureDevOpsPullRequestsAwaitingMyReview(
  repo: AzureDevOpsRepoRef
): Promise<AzureDevOpsPrSummary[]> {
  const { collection } = resolveAzureDevOpsApiBases(repo)
  const me = await getAzureDevOpsCurrentUserId(collection)
  if (!me) {
    throw new Error('Azure DevOps did not say who is signed in; run az login or check the token.')
  }
  const list = await requestAzureDevOpsJsonAtBase<{ value?: RawPullRequest[] }>(
    collection,
    '/_apis/git/pullrequests',
    {
      searchParams: {
        'searchCriteria.status': 'active',
        'searchCriteria.reviewerId': me,
        $top: String(AWAITING_REVIEW_LIMIT)
      },
      timeoutMs: PR_READ_TIMEOUT_MS
    },
    true
  )
  return (list?.value ?? [])
    .filter((pr) => pr.isDraft !== true)
    .map((pr) => mapPullRequestSummary(pr, collection, me))
    .filter((pr): pr is AzureDevOpsPrSummary => pr !== null)
}

/** PR ids are unique per organization, so any repo of that organization can resolve one. */
export async function getAzureDevOpsPullRequestDetail(
  repo: AzureDevOpsRepoRef,
  id: number
): Promise<{ detail: AzureDevOpsPrDetail; location: PullRequestLocation } | null> {
  const { collection } = resolveAzureDevOpsApiBases(repo)
  const [raw, me] = await Promise.all([
    requestAzureDevOpsJsonAtBase<RawPullRequest>(
      collection,
      `/_apis/git/pullrequests/${encodeURIComponent(String(id))}`,
      { timeoutMs: PR_READ_TIMEOUT_MS }
    ),
    getAzureDevOpsCurrentUserId(collection).catch(() => null)
  ])
  const summary = raw ? mapPullRequestSummary(raw, collection, me) : null
  const projectId = raw?.repository?.project?.id
  const repositoryId = raw?.repository?.id
  if (!raw || !summary || !projectId || !repositoryId) {
    return null
  }
  const location = { collection, projectId, repositoryId }
  const iterations = await requestAzureDevOpsJsonAtBase<{ value?: unknown[] }>(
    collection,
    `${pullRequestPath(location, id)}/iterations`,
    { timeoutMs: PR_READ_TIMEOUT_MS },
    true
  )
  return {
    location,
    detail: {
      ...summary,
      description: raw.description ?? '',
      mergeStatus: raw.mergeStatus ?? null,
      reviewers: mapReviewers(raw.reviewers, me),
      iterationCount: iterations?.value?.length ?? 0,
      sourceCommit: raw.lastMergeSourceCommit?.commitId ?? null,
      targetCommit: raw.lastMergeTargetCommit?.commitId ?? null
    }
  }
}

export function pullRequestPath(location: PullRequestLocation, id: number): string {
  return `/${encodeURIComponent(location.projectId)}/_apis/git/repositories/${encodeURIComponent(
    location.repositoryId
  )}/pullRequests/${encodeURIComponent(String(id))}`
}

/** Only active PRs: a completed PR from an earlier use of the branch name is not this branch's. */
export async function listAzureDevOpsActivePullRequestsForBranch(
  repo: AzureDevOpsRepoRef,
  branch: string
): Promise<AzureDevOpsPrSummary[]> {
  const bases = resolveAzureDevOpsApiBases(repo)
  const list = await requestAzureDevOpsJsonAtBase<{ value?: RawPullRequest[] }>(
    bases.project,
    `/_apis/git/repositories/${encodeURIComponent(repo.repository)}/pullrequests`,
    {
      searchParams: {
        'searchCriteria.sourceRefName': `refs/heads/${branch.replace(/^refs\/heads\//, '')}`,
        'searchCriteria.status': 'active'
      },
      timeoutMs: PR_READ_TIMEOUT_MS
    },
    true
  )
  return (list?.value ?? [])
    .map((pr) => mapPullRequestSummary(pr, bases.collection, null))
    .filter((pr): pr is AzureDevOpsPrSummary => pr !== null)
}

/** Where a PR lives, for the reads that need its project and repository ids. */
export async function locateAzureDevOpsPullRequest(
  repo: AzureDevOpsRepoRef,
  id: number
): Promise<PullRequestLocation> {
  const { collection } = resolveAzureDevOpsApiBases(repo)
  const raw = await requestAzureDevOpsJsonAtBase<RawPullRequest>(
    collection,
    `/_apis/git/pullrequests/${encodeURIComponent(String(id))}`,
    { timeoutMs: PR_READ_TIMEOUT_MS },
    true
  )
  const projectId = raw?.repository?.project?.id
  const repositoryId = raw?.repository?.id
  if (!projectId || !repositoryId) {
    throw new Error(`Pull request ${id} was not found in this organization.`)
  }
  return { collection, projectId, repositoryId }
}
