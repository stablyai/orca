import { translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(at: number): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** When offline data was read, as an "as of" line names it: a time today, then the day, then the date. */
export function formatOfflineAsOfTime(at: number, now: number = Date.now()): string {
  const locale = getUiIntlLocale()
  // Rounded so a daylight-saving day still counts as one.
  const daysAgo = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS)
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at)
  if (daysAgo <= 0) {
    return time
  }
  if (daysAgo === 1) {
    return translate('components.offlineAsOfTime.yesterday', 'yesterday, {{time}}', { time })
  }
  if (daysAgo < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(at)
  }
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(at)
}
