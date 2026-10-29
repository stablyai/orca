import type { Translate } from '../i18n/mobile-i18n'

export function nativeChatDiffCardCopy(t: Translate) {
  return {
    diffTruncated: t('chat.diffCard.diffTruncated', 'Diff truncated'),
    diffGap: t('chat.diffCard.diffGap', 'Lines not shown'),
    copyDiff: t('chat.diffCard.copyDiff', 'Copy diff')
  }
}
