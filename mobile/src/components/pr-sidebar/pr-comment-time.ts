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
    return t('m.xbjFHYU')
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return t('m.XG7ieU0', { value0: minutes })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return t('m.J9EQWOE', { value0: hours })
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    return t('m.3u9-Kuw', { value0: days })
  }
  const months = Math.floor(days / 30)
  if (months < 12) {
    return t('m.5mTslyc', { value0: months })
  }
  return t('m.rBMjMUM', { value0: Math.floor(months / 12) })
}
