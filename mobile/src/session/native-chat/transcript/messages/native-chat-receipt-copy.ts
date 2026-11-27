import type { Translate } from '../../../../i18n/mobile-i18n'

export function nativeChatReceiptCopy(t: Translate, device?: string) {
  return {
    emptyAnswer: t('chat.receipt.emptyAnswer', 'Empty answer'),
    unavailable: t('chat.receipt.unavailable', 'Selected answer unavailable'),
    resolved: t('chat.receipt.resolved', 'Resolved'),
    cancelled: t('chat.receipt.cancelled', 'Cancelled'),
    resolver: t('chat.receipt.resolver', 'Answered on {{device}}', { device }),
    cancelledBy: t('chat.receipt.cancelledBy', 'Cancelled on {{device}}', { device }),
    questionCancelled: t('chat.receipt.questionCancelled', 'Question cancelled'),
    answeredCount: (count: number) =>
      t('chat.receipt.answeredCount', 'You answered <answer>{{count}} questions</answer>', {
        count
      })
  }
}
