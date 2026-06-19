import type { HostedReviewProvider } from '../../../src/shared/hosted-review'

// Provider-aware review labels, ported from the desktop localized-copy mapping
// (src/renderer/src/i18n/hosted-review-localized-copy.ts) minus i18n. GitLab uses
// "Merge Request"; everything else uses "Pull Request". Keeps the mobile create
// UI provider-agnostic instead of hardcoding GitHub naming.
export type HostedReviewCopy = {
  shortLabel: string // "PR" / "MR"
  reviewLabel: string // "pull request" / "merge request"
  titleLabel: string // "Pull Request" / "Merge Request"
}

const PR_COPY: HostedReviewCopy = {
  shortLabel: 'PR',
  reviewLabel: 'pull request',
  titleLabel: 'Pull Request'
}

const MR_COPY: HostedReviewCopy = {
  shortLabel: 'MR',
  reviewLabel: 'merge request',
  titleLabel: 'Merge Request'
}

export function hostedReviewCopy(provider: HostedReviewProvider | undefined): HostedReviewCopy {
  return provider === 'gitlab' ? MR_COPY : PR_COPY
}
