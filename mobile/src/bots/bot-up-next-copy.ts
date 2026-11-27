// Up next and Look around wording on the phone, as the desktop words them.
import { lookedDay } from '../../../src/shared/bots/bot-look-around'
import { translate, type Translate } from '../i18n/mobile-i18n'

/** "4:12 PM" today, "yesterday 4:12 PM", then "Oct 29". */
export function lookedWhen(at: number, t: Translate, intlLocale: string, now = Date.now()): string {
  const day = lookedDay(at, now)
  if (day === 'earlier') {
    return new Intl.DateTimeFormat(intlLocale, { month: 'short', day: 'numeric' }).format(at)
  }
  const time = new Intl.DateTimeFormat(intlLocale, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(at)
  return day === 'today' ? time : t('bots.upNext.yesterdayAt', 'yesterday {{time}}', { time })
}

export function lookedText(at: number, t: Translate, intlLocale: string, now = Date.now()): string {
  return t('bots.upNext.looked', 'Looked {{time}}', { time: lookedWhen(at, t, intlLocale, now) })
}

/** Why the host would not start a look, from its refusal code. */
export function lookNowRefusalText(message: string): string {
  if (message.includes('look_now_running')) {
    return translate('bots.upNext.lookNowRunning', 'Already looking around.')
  }
  if (message.includes('look_now_paused')) {
    return translate('bots.upNext.lookNowPaused', 'Turn the bot on to look around.')
  }
  return translate('bots.upNext.lookNowFailed', 'Couldn’t start a look. Try again.')
}
