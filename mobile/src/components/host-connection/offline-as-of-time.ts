import { translate } from '../../i18n/mobile-i18n'
import { getUiIntlLocale, uiDateTimeFormat } from '../../i18n/ui-intl-locale'
import { CLOCK_TIME, SHORT_MONTH_DAY } from '../../../../src/shared/i18n/regional-date-time-format'

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
  const time = uiDateTimeFormat(CLOCK_TIME).format(at)
  if (daysAgo <= 0) {
    return time
  }
  if (daysAgo === 1) {
    return translate('components.offlineAsOfTime.yesterday', 'yesterday, {{time}}', { time })
  }
  if (daysAgo < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(at)
  }
  return uiDateTimeFormat(SHORT_MONTH_DAY).format(at)
}
