import type {
  MobileWebTaskGitHubDetailResult,
  MobileWebTaskGitHubUser
} from '../../../src/shared/mobile-web/task-detail-contract'

type GitHubRawDetails = Partial<MobileWebTaskGitHubDetailResult> & {
  item?: {
    labels?: string[]
    reviewDecision?: string | null
    reviewRequests?: MobileWebTaskGitHubUser[]
    latestReviews?: MobileWebTaskGitHubDetailResult['latestReviews']
  }
}

export function projectGitHubTaskDetail(value: unknown): MobileWebTaskGitHubDetailResult {
  const details = value as GitHubRawDetails | null
  if (!details) {
    throw new Error('Details not found')
  }
  return {
    body: details.body ?? '',
    comments: details.comments ?? [],
    labels: details.item?.labels ?? details.labels,
    assignees: details.assignees ?? [],
    reviewDecision: details.item?.reviewDecision ?? details.reviewDecision,
    reviewRequests: details.item?.reviewRequests ?? details.reviewRequests,
    latestReviews: details.item?.latestReviews ?? details.latestReviews,
    headSha: details.headSha,
    baseSha: details.baseSha,
    pullRequestId: details.pullRequestId,
    checks: details.checks ?? [],
    files: details.files ?? []
  }
}
