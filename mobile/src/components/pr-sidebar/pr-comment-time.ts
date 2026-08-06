import { t } from '@/i18n/mobile-i18n'
// Relative timestamp for PR comments (ISO string in, "Xm/Xh/Xd/Xmo/Xy" out),
// mirroring the desktop formatRelativeTime so the timeline reads the same. Pure +
// unit-testable; nowMs is passed in (Date.now() is unavailable in some contexts).
export function formatPrCommentRelativeTime(iso: string, nowMs: number): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) {
    return ''
  }
  const delta = nowMs - ts
  if (delta < 60_000) {
    return t('prCommentTime.just')
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return t('prCommentTime.minutes', { minutes: minutes })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return t('prCommentTime.hours', { hours: hours })
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    return t('prCommentTime.days', { days: days })
  }
  const months = Math.floor(days / 30)
  if (months < 12) {
    return t('prCommentTime.months', { months: months })
  }
  return t('prCommentTime.years', {
    years: Math.floor(months / 12)
  })
}
