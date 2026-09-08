import type { GitLabProjectRef } from '../../../../shared/gitlab-types'
import type { GitHubRepositoryIdentity } from '../../../../shared/github/pull-request-types'
import type { MobileWebReviewDetails } from './mobile-web-review-scope'

type LoadedReviewDetails = Extract<MobileWebReviewDetails, { state: 'loaded' }>

/** GitHub addresses a fork's pull request by its own repository slug, not the local repo. */
export function gitHubReviewTarget(details: LoadedReviewDetails): GitHubRepositoryIdentity | null {
  return details.provider === 'github' ? (details.item.item.prRepo ?? null) : null
}

export function gitLabReviewTarget(details: LoadedReviewDetails): GitLabProjectRef | null {
  return details.provider === 'gitlab' ? (details.item.item.projectRef ?? null) : null
}

/** The provider's inline-comment anchor. GitHub needs only the head; GitLab needs all three shas,
 *  and a head that has moved past the one the page composed against anchors nothing. */
export function reviewInlinePosition(
  details: LoadedReviewDetails,
  expectedHead: string
): { headSha: string; baseSha?: string; startSha?: string } | null {
  if (details.item.headSha !== expectedHead) {
    return null
  }
  return {
    headSha: expectedHead,
    ...(details.item.baseSha === undefined ? {} : { baseSha: details.item.baseSha }),
    ...(details.provider === 'gitlab' && details.item.startSha !== undefined
      ? { startSha: details.item.startSha }
      : {})
  }
}
