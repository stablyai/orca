import type { Translate } from '../../../i18n/mobile-i18n'

export function nativeChatNoticeCopy(t: Translate) {
  return {
    compaction: t('chat.notice.compaction', 'Context compacted'),
    contextCleared: t('chat.notice.contextCleared', 'Context cleared'),
    plan: t('chat.notice.plan', 'Plan')
  }
}

export function nativeChatHostStatusCopy(t: Translate) {
  return {
    'history-repaired': t(
      'chat.hostStatus.historyRepaired',
      "Part of this chat's history couldn't be loaded."
    ),
    'history-item-too-large': t(
      'chat.hostStatus.historyItemTooLarge',
      'This part of the chat was too large to show.'
    ),
    'continued-outside': t('chat.hostStatus.continuedOutside', 'Continued outside this chat.'),
    'continued-outside-rewound': t(
      'chat.hostStatus.continuedOutsideRewound',
      "Continued outside this chat. Earlier replies above are no longer in this conversation's history."
    )
  }
}
