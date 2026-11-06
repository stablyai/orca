import type { Translate } from '../../i18n/mobile-i18n'

export function commentRelativeTime(iso: string, now: number, t: Translate): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) {
    return ''
  }
  const delta = now - timestamp
  if (delta < 60_000) {
    return t('pullRequest.commentCard.justNow', 'just now')
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    const count = minutes
    return count === 1
      ? t('pullRequest.commentCard.minutesAgo_one', '{{count}}m ago', { count })
      : t('pullRequest.commentCard.minutesAgo_other', '{{count}}m ago', { count })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const count = hours
    return count === 1
      ? t('pullRequest.commentCard.hoursAgo_one', '{{count}}h ago', { count })
      : t('pullRequest.commentCard.hoursAgo_other', '{{count}}h ago', { count })
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    const count = days
    return count === 1
      ? t('pullRequest.commentCard.daysAgo_one', '{{count}}d ago', { count })
      : t('pullRequest.commentCard.daysAgo_other', '{{count}}d ago', { count })
  }
  const months = Math.floor(days / 30)
  if (months < 12) {
    const count = months
    return count === 1
      ? t('pullRequest.commentCard.monthsAgo_one', '{{count}}mo ago', { count })
      : t('pullRequest.commentCard.monthsAgo_other', '{{count}}mo ago', { count })
  }
  const count = Math.floor(months / 12)
  return count === 1
    ? t('pullRequest.commentCard.yearsAgo_one', '{{count}}y ago', { count })
    : t('pullRequest.commentCard.yearsAgo_other', '{{count}}y ago', { count })
}
