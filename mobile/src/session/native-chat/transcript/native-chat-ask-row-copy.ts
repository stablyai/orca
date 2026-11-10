import type { Translate } from '../../../i18n/mobile-i18n'

export function nativeChatAskRowCopy(t: Translate, value0?: number) {
  return {
    awaiting: t('chat.askRow.awaiting', 'Awaiting user input:'),
    awaitingUnnamed: t('chat.askRow.awaitingUnnamed', 'Awaiting user input'),
    asked: t('chat.askRow.asked', 'Asked:'),
    questionCount: t('chat.askRow.questionCount', '{{value0}} questions', { value0 })
  }
}
