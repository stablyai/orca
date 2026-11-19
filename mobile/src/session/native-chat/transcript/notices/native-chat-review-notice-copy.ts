import type { NativeChatNoticeLook } from '../../../../../../src/shared/native-chat/transcript/notices/native-chat-notice'
import type { Translate } from '../../../../i18n/mobile-i18n'

type ReviewLook = Extract<
  NativeChatNoticeLook,
  { kind: 'settled-permission' | 'auto-review-denied' }
>

/** The collapsed line of a reviewed action: a settled permission or an automatic review's denial. */
export function nativeChatReviewNoticeSummary(
  look: ReviewLook,
  agent: string,
  t: Translate
): string {
  if (look.kind === 'auto-review-denied') {
    return t('chat.notice.autoReviewDenied', "{{agent}}'s automatic review denied: {{action}}", {
      agent,
      action: look.denial.summary
    })
  }
  if (look.decision === 'approved') {
    return t('chat.notice.safetyReviewApproved', '{{agent}} approved this action. View details.', {
      agent
    })
  }
  if (look.decision === 'denied') {
    return t('chat.notice.permissionDenied', '{{agent}} denied permission. View details.', {
      agent
    })
  }
  return t(
    'chat.notice.safetyReview',
    '{{agent}} reported a safety review warning. View details.',
    {
      agent
    }
  )
}
