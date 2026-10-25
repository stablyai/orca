// Use the desktop provider vocabulary: GitLab says Merge Request.
export type HostedReviewCopy = {
  shortLabel: string
  reviewLabel: string
  titleLabel: string
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

export function hostedReviewCopy(provider: string | undefined): HostedReviewCopy {
  return provider === 'gitlab' ? MR_COPY : PR_COPY
}
