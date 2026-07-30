import type { HostedReviewProvider } from '../../../src/shared/hosted-review'
import { t } from '@/i18n/mobile-i18n'

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
  shortLabel: t('m.Qic_Aa4'),
  reviewLabel: t('m.rUwwMh4'),
  titleLabel: t('m.GqNlrAs')
}

const MR_COPY: HostedReviewCopy = {
  shortLabel: t('m.BWWtnQM'),
  reviewLabel: t('m.OpWJNnA'),
  titleLabel: t('m.cTkYeR8')
}

export function hostedReviewCopy(provider: HostedReviewProvider | undefined): HostedReviewCopy {
  return provider === 'gitlab' ? MR_COPY : PR_COPY
}
