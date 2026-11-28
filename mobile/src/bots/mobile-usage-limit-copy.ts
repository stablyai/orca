// The phone's one way to say when a usage limit lifts, for agent rows, Home and chat.
import type { UsageLimitStop } from '../../../src/shared/bots/bot-usage-limit-stop'
import type { Translate } from '../i18n/mobile-i18n'

const WEEK_MS = 6 * 24 * 60 * 60_000

/** "1:40 AM" today, "Tue 1:40 AM" within the week, else "Nov 24". */
export function mobileUsageLimitClock(at: number, now: number, intlLocale: string): string {
  const today = new Date(at).toDateString() === new Date(now).toDateString()
  const options: Intl.DateTimeFormatOptions = today
    ? { hour: 'numeric', minute: '2-digit' }
    : Math.abs(at - now) < WEEK_MS
      ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric' }
  return new Intl.DateTimeFormat(intlLocale, options).format(at)
}

/** "Continues 1:40 AM", or "Hit limit · resets 1:40 AM" when Orca won't continue it. */
export function mobileUsageLimitStopText(
  stop: UsageLimitStop,
  now: number,
  t: Translate,
  intlLocale: string
): string {
  const time = mobileUsageLimitClock(stop.at, now, intlLocale)
  return stop.auto
    ? t('bots.usageLimit.continues', 'Continues {{time}}', { time })
    : t('bots.usageLimit.hitLimit', 'Hit limit · resets {{time}}', { time })
}
