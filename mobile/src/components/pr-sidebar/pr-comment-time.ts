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
    return 'just now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    return `${days}d ago`
  }
  const months = Math.floor(days / 30)
  if (months < 12) {
    return `${months}mo ago`
  }
  return `${Math.floor(months / 12)}y ago`
}
