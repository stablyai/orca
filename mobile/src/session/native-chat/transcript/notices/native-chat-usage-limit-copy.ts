import {
  formatUsageLimitResetClock,
  type AgentSessionUsageLimit
} from '../../../../../../src/shared/agent-session/failures/agent-session-usage-limit'
import type { NativeChatUsageLimitAutoContinueKind } from '../../../../../../src/shared/native-chat/native-chat-usage-limit-auto-continue'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { getUiIntlLocale } from '../../../../i18n/ui-intl-locale'

/** A reset time in the phone's UI language. */
function usageLimitResetClock(resetsAt: number): string {
  return formatUsageLimitResetClock(resetsAt, Date.now(), getUiIntlLocale())
}

/** The card's headline; the reset time and what Orca will do sit on its status line. */
export function nativeChatUsageLimitText(
  limit: AgentSessionUsageLimit | undefined,
  agentName: string | null | undefined,
  t: Translate
): string {
  const agent = agentName || t('chat.usageLimit.theAgent', 'The agent')
  const windows = {
    session: t('chat.usageLimit.windowSession', 'session'),
    weekly: t('chat.usageLimit.windowWeekly', 'weekly'),
    weeklyModel: t('chat.usageLimit.windowWeeklyModel', 'weekly model'),
    credits: t('chat.usageLimit.windowCredits', 'extra usage')
  }
  return limit?.window
    ? t('chat.usageLimit.reachedNamed', '{{agent}} hit its {{window}} limit.', {
        agent,
        window: windows[limit.window]
      })
    : t('chat.usageLimit.reached', '{{agent}} hit its usage limit.', { agent })
}

/** One status line: when the limit resets, then what Orca will do about it. */
export function nativeChatUsageLimitStatusText(
  status: {
    resetsAt: number | undefined
    resetPassed: boolean
    autoContinue: Exclude<NativeChatUsageLimitAutoContinueKind, 'off'> | null
  },
  t: Translate
): string {
  const { resetsAt, resetPassed, autoContinue } = status
  const parts = [
    resetsAt === undefined
      ? null
      : resetPassed
        ? t('chat.usageLimit.statusResetAt', 'Reset at {{time}}', {
            time: usageLimitResetClock(resetsAt)
          })
        : t('chat.usageLimit.statusResetsAt', 'Resets at {{time}}', {
            time: usageLimitResetClock(resetsAt)
          }),
    autoContinue === 'scheduled'
      ? resetPassed
        ? t('chat.usageLimit.statusContinuesShortly', 'Orca continues shortly')
        : t('chat.usageLimit.statusContinuesThen', 'Orca continues then')
      : autoContinue === 'cancelled'
        ? t('chat.usageLimit.statusWontContinue', "Orca won't continue automatically")
        : null
  ]
  return parts.filter((part) => part !== null).join(' · ')
}
