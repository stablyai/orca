import type { Translate } from '../i18n/mobile-i18n'
import type { MobileAutomationRow } from './automation-reply-schema'
import { automationDate } from './automation-run-presentation'

type NextRunFields = Pick<MobileAutomationRow['automation'], 'enabled' | 'nextRunAt' | 'timezone'>

const DAY_MS = 24 * 60 * 60 * 1000

function localDay(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS
}

/** The next run in the phone's words: today, tomorrow, a weekday this week, else its date. */
export function automationNextRunShortLabel(
  automation: NextRunFields,
  t: Translate,
  intlLocale: string,
  now = Date.now()
): string {
  if (!automation.enabled) {
    return t('automations.mobile.noNextScheduledRun', 'No next scheduled run')
  }
  const at = new Date(automation.nextRunAt)
  const time = new Intl.DateTimeFormat(intlLocale, { hour: 'numeric', minute: '2-digit' }).format(
    at
  )
  const days = localDay(automation.nextRunAt) - localDay(now)
  if (days === 0) {
    return t('automations.mobile.nextRunToday', 'Next run today at {{time}}', { time })
  }
  if (days === 1) {
    return t('automations.mobile.nextRunTomorrow', 'Next run tomorrow at {{time}}', {
      time
    })
  }
  if (days > 1 && days < 7) {
    return t('automations.mobile.nextRunWeekday', 'Next run {{day}} at {{time}}', {
      day: new Intl.DateTimeFormat(intlLocale, { weekday: 'long' }).format(at),
      time
    })
  }
  return t('automations.mobile.nextRunDate', 'Next run {{date}}', {
    date: automationDate(automation.nextRunAt, t, intlLocale)
  })
}
