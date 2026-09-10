import type { HostTaskGitHubDetail } from './host-task-provider-payloads'
import type { GitHubWorkItemDetails } from '../../../src/shared/github/work-item-types'

import type { DetailComment } from './mobile-tasks-provider-detail-types'

type GitHubRawDetails = Partial<Omit<GitHubWorkItemDetails, 'item' | 'comments'>> & {
  comments?: DetailComment[]
  item?: Partial<GitHubWorkItemDetails['item']>
}

export function projectGitHubTaskDetail(value: unknown): HostTaskGitHubDetail {
  const details = value as GitHubRawDetails | null
  if (!details) {
    throw new Error('Details not found')
  }
  return {
    body: details.body ?? '',
    comments: details.comments ?? [],
    labels: details.item?.labels,
    assignees: details.assignees ?? [],
    reviewDecision: details.item?.reviewDecision,
    reviewRequests: details.item?.reviewRequests,
    latestReviews: details.item?.latestReviews,
    headSha: details.headSha,
    baseSha: details.baseSha,
    pullRequestId: details.pullRequestId,
    checks: details.checks ?? [],
    files: details.files ?? []
  }
}
