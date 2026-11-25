import { translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import type { MobileAutomationRow } from './automation-reply-schema'
import { automationDate } from './automation-run-presentation'

type NextRunFields = Pick<MobileAutomationRow['automation'], 'enabled' | 'nextRunAt' | 'timezone'>

/** "Next: <date>" in the automation's own timezone, or that a paused one has none. */
export function automationNextRunLabel(automation: NextRunFields): string {
  return automation.enabled
    ? translate('automations.mobile.nextDate', 'Next: {{date}}', {
        date: automationDate(automation.nextRunAt, automation.timezone)
      })
    : translate('automations.mobile.noNextScheduledRun', 'No next scheduled run')
}

const DAY_MS = 24 * 60 * 60 * 1000

function localDay(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS
}

/** The next run in the phone's words: today, tomorrow, a weekday this week, else its date. */
export function automationNextRunShortLabel(automation: NextRunFields, now = Date.now()): string {
  if (!automation.enabled) {
    return translate('automations.mobile.noNextScheduledRun', 'No next scheduled run')
  }
  const at = new Date(automation.nextRunAt)
  const locale = getUiIntlLocale()
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at)
  const days = localDay(automation.nextRunAt) - localDay(now)
  if (days === 0) {
    return translate('automations.mobile.nextRunToday', 'Next run today at {{time}}', { time })
  }
  if (days === 1) {
    return translate('automations.mobile.nextRunTomorrow', 'Next run tomorrow at {{time}}', {
      time
    })
  }
  if (days > 1 && days < 7) {
    return translate('automations.mobile.nextRunWeekday', 'Next run {{day}} at {{time}}', {
      day: new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(at),
      time
    })
  }
  return translate('automations.mobile.nextRunDate', 'Next run {{date}}', {
    date: automationDate(automation.nextRunAt)
  })
}
