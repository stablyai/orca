import type { AgentSessionUsageLimit } from '../../../../../src/shared/agent-session-usage-limit'
import { joinSentences } from '../../../../../src/shared/sentence-joining'
import type { Translate } from '../../../i18n/mobile-i18n'
import { getUiIntlLocale } from '../../../i18n/ui-intl-locale'

function usageLimitResetClock(resetsAt: number): string {
  const at = new Date(resetsAt)
  const today = at.toDateString() === new Date(Date.now()).toDateString()
  return new Intl.DateTimeFormat(
    getUiIntlLocale(),
    today
      ? { hour: 'numeric', minute: '2-digit' }
      : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  ).format(at)
}

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
  const lead = limit?.window
    ? t('chat.usageLimit.reachedNamed', '{{agent}} hit its {{window}} limit.', {
        agent,
        window: windows[limit.window]
      })
    : t('chat.usageLimit.reached', '{{agent}} hit its usage limit.', { agent })
  return joinSentences([
    lead,
    ...(limit?.resetsAt !== undefined
      ? [
          t('chat.usageLimit.resetsAt', 'It resets at {{when}}.', {
            when: usageLimitResetClock(limit.resetsAt)
          })
        ]
      : [])
  ])
}
