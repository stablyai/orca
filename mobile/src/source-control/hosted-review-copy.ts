import { translate } from '../i18n/mobile-i18n'
import type { MobileHostedReviewCreateIntentProgress } from './mobile-hosted-review-create-intent'

// Use the desktop provider vocabulary: GitLab says Merge Request.
export type HostedReviewCopy = {
  shortLabel: string
  reviewLabel: string
  titleLabel: string
}

function prCopy(): HostedReviewCopy {
  return {
    shortLabel: translate('sourceControl.hostedReview.prCopy.shortLabel', 'PR'),
    reviewLabel: translate('sourceControl.hostedReview.prCopy.reviewLabel', 'pull request'),
    titleLabel: translate('sourceControl.hostedReview.prCopy.titleLabel', 'Pull Request')
  }
}

function mrCopy(): HostedReviewCopy {
  return {
    shortLabel: translate('sourceControl.hostedReview.mrCopy.shortLabel', 'MR'),
    reviewLabel: translate('sourceControl.hostedReview.mrCopy.reviewLabel', 'merge request'),
    titleLabel: translate('sourceControl.hostedReview.mrCopy.titleLabel', 'Merge Request')
  }
}

export function hostedReviewCopy(provider: string | undefined): HostedReviewCopy {
  return provider === 'gitlab' ? mrCopy() : prCopy()
}

export function mobileHostedReviewCreateIntentProgressMessage(
  progress: MobileHostedReviewCreateIntentProgress
): string {
  switch (progress) {
    case 'fast_forwarding':
      return translate('sourceControl.hostedReviewCopy.updatingBranch', 'Updating branch...')
    case 'staging':
      return translate('sourceControl.hostedReviewCopy.stagingChanges', 'Staging changes...')
    case 'generating_commit_message':
      return translate(
        'sourceControl.hostedReviewCopy.generatingCommitMessage',
        'Generating commit message...'
      )
    case 'committing':
      return translate('sourceControl.hostedReviewCopy.committingChanges', 'Committing changes...')
    case 'publishing':
      return translate('sourceControl.hostedReviewCopy.publishingBranch', 'Publishing branch...')
    case 'pushing':
      return translate('sourceControl.hostedReviewCopy.pushingCommits', 'Pushing commits...')
    case 'force_pushing':
      return translate('sourceControl.hostedReviewCopy.forcePushing', 'Force pushing with lease...')
    case 'creating_review':
      return translate('sourceControl.hostedReviewCopy.creatingReview', 'Creating review...')
  }
}
