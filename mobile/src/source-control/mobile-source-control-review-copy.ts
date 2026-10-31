import { translate } from '../i18n/mobile-i18n'
import type { MobileSourceControlReviewInputs } from './mobile-source-control-primary-action'

// Mobile pushes without a review's saved push target, so a force push there could overwrite the wrong branch.
export function getMobileForcePushBlockedReason(
  review: MobileSourceControlReviewInputs | undefined
): string | undefined {
  return review?.pushTarget
    ? translate(
        'sourceControl.primaryAction.forcePushFromDesktop',
        "Force push this pull request's branch from desktop"
      )
    : undefined
}
