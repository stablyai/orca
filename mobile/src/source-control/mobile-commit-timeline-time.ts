import { translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { NATIVE_CHAT_MESSAGE_TIME_FORMAT } from '../../../src/shared/native-chat/transcript/native-chat-message-time'

const DAY_MS = 24 * 60 * 60 * 1000

// Formatter construction is slow on Hermes; rows reuse one per locale and style.
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(style: 'time' | 'weekday' | 'date' | 'dateWithYear'): Intl.DateTimeFormat {
  const locale = getUiIntlLocale()
  const key = `${locale}\0${style}`
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(
      locale,
      style === 'time'
        ? NATIVE_CHAT_MESSAGE_TIME_FORMAT
        : style === 'weekday'
          ? { weekday: 'long' }
          : style === 'date'
            ? { month: 'short', day: 'numeric' }
            : { month: 'short', day: 'numeric', year: 'numeric' }
    )
    formatters.set(key, formatter)
  }
  return formatter
}

export function startOfLocalDay(timestampMs: number): number {
  const date = new Date(timestampMs)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// Today's commits read as an age; older ones sit under a day header, so they show the clock time.
export function formatTimelineCommitTime(
  timestampMs: number | null,
  nowMs: number,
  todayStartMs: number
): string {
  if (timestampMs === null) {
    return ''
  }
  if (timestampMs < todayStartMs) {
    return formatterFor('time').format(timestampMs)
  }
  const minutes = Math.floor((nowMs - timestampMs) / 60_000)
  if (minutes < 1) {
    return translate('sourceControl.commitTimeline.justNow', 'now')
  }
  if (minutes < 60) {
    return translate('sourceControl.commitTimeline.minutes', '{{count}} min', { count: minutes })
  }
  return translate('sourceControl.commitTimeline.hours', '{{count}} hr', {
    count: Math.floor(minutes / 60)
  })
}

export function formatTimelineDay(dayStartMs: number, todayStartMs: number): string {
  const daysAgo = Math.round((todayStartMs - dayStartMs) / DAY_MS)
  if (daysAgo === 1) {
    return translate('sourceControl.commitTimeline.yesterday', 'Yesterday')
  }
  if (daysAgo < 7) {
    return formatterFor('weekday').format(dayStartMs)
  }
  const sameYear = new Date(dayStartMs).getFullYear() === new Date(todayStartMs).getFullYear()
  return formatterFor(sameYear ? 'date' : 'dateWithYear').format(dayStartMs)
}

// The detail list's full date: "Today at 9:14 AM", "Yesterday at …", or the date and time.
export function formatCommitDateTime(timestampMs: number, nowMs: number): string {
  const locale = getUiIntlLocale()
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(
    timestampMs
  )
  const daysAgo = Math.round((startOfLocalDay(nowMs) - startOfLocalDay(timestampMs)) / DAY_MS)
  if (daysAgo === 0) {
    return translate('sourceControl.commitTimeline.todayAt', 'Today at {{time}}', { time })
  }
  if (daysAgo === 1) {
    return translate('sourceControl.commitTimeline.yesterdayAt', 'Yesterday at {{time}}', { time })
  }
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(timestampMs)
  return translate('sourceControl.commitTimeline.dateAt', '{{date}} at {{time}}', { date, time })
}
