import { publishDocPreviewFailure } from './doc-preview-failure-notice'
import { onDocPreviewGrantRevoked } from './doc-preview-grant-registry'
import { readDocPreviewGuestBoundGrantId } from './doc-preview-guest-policy'

// Throttle repeated download attempts so a document cannot flood the preview notice UI.
const NOTICE_MIN_INTERVAL_MS = 2_000
const noticedAtByGrantId = new Map<string, number>()

onDocPreviewGrantRevoked((grant) => noticedAtByGrantId.delete(grant.id))

export function noticeDocPreviewDownloadBlocked(guest: Electron.WebContents): void {
  const grantId = readDocPreviewGuestBoundGrantId(guest)
  if (grantId === null) {
    return
  }
  const now = Date.now()
  // Expire inactive grants while checking the throttle.
  for (const [noticedGrantId, noticedAt] of noticedAtByGrantId) {
    if (now - noticedAt >= NOTICE_MIN_INTERVAL_MS) {
      noticedAtByGrantId.delete(noticedGrantId)
    }
  }
  if (noticedAtByGrantId.has(grantId)) {
    return
  }
  noticedAtByGrantId.set(grantId, now)
  publishDocPreviewFailure({ grantId, reason: 'download-blocked' })
}
