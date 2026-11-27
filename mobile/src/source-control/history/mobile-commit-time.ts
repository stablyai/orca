import type { Translate } from '../../i18n/mobile-i18n'

export function formatCommitTime(
  timestampMs: number | null | undefined,
  nowMs: number,
  t: Translate
): string {
  // Epoch zero is valid; test nullishness instead of truthiness.
  if (timestampMs == null) {
    return ''
  }
  const delta = nowMs - timestampMs
  if (delta < 60_000) {
    return t('sourceControl.gitHistory.justNow', 'just now')
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    const count = minutes
    return count === 1
      ? t('sourceControl.gitHistory.minutes_one', '{{count}}m', { count })
      : t('sourceControl.gitHistory.minutes_other', '{{count}}m', { count })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const count = hours
    return count === 1
      ? t('sourceControl.gitHistory.hours_one', '{{count}}h', { count })
      : t('sourceControl.gitHistory.hours_other', '{{count}}h', { count })
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    const count = days
    return count === 1
      ? t('sourceControl.gitHistory.days_one', '{{count}}d', { count })
      : t('sourceControl.gitHistory.days_other', '{{count}}d', { count })
  }
  const months = Math.floor(days / 30)
  if (months < 12) {
    const count = months
    return count === 1
      ? t('sourceControl.gitHistory.months_one', '{{count}}mo', { count })
      : t('sourceControl.gitHistory.months_other', '{{count}}mo', { count })
  }
  const count = Math.floor(months / 12)
  return count === 1
    ? t('sourceControl.gitHistory.years_one', '{{count}}y', { count })
    : t('sourceControl.gitHistory.years_other', '{{count}}y', { count })
}
