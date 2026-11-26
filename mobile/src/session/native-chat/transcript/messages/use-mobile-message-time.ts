import {
  getNativeChatMessageDay,
  getNativeChatMessageTimeFormatter
} from '../../../../../../src/shared/native-chat/transcript/messages/native-chat-message-time'
import { useSharedNowSnapshot } from '../../../../hooks/use-now'
import { getUiIntlLocale } from '../../../../i18n/ui-intl-locale'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'

export type MobileMessageTime = { label: (at: number) => string; full: (at: number) => string }

/** Chat's time words: "2:56 PM" today, "Yesterday 2:56 PM", "Nov 14, 2:56 PM", then with the year.
 *  Re-renders only when the day changes. */
export function useMobileMessageTime(enabled = true): MobileMessageTime {
  const t = useMobileTranslation()
  const today = useSharedNowSnapshot(30_000, getNativeChatMessageDay, enabled)
  const formatter = getNativeChatMessageTimeFormatter(getUiIntlLocale(), today)
  // An Invalid Date reads as no time: Intl throws on it.
  const valid = (at: number): Date | null => {
    const date = new Date(at)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return {
    label: (at) => {
      const date = valid(at)
      return date
        ? formatter.format(date, today.date, (time) =>
            t('chat.messageTime.yesterday', 'Yesterday {{time}}', { time })
          )
        : ''
    },
    full: (at) => {
      const date = valid(at)
      return date ? formatter.formatFull(date) : ''
    }
  }
}
