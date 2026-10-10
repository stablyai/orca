import { publishDocPreviewFailure } from './doc-preview-failure-notice'
import { onDocPreviewGrantRevoked } from './doc-preview-grant-registry'
import { readDocPreviewGuestBoundGrantId } from './doc-preview-guest-policy'

/**
 * Why the reader is told at all, when the point of the fence is that nothing happens: a press that
 * produces no file and no explanation reads as Orca being broken. The notice is chrome the document
 * cannot see or read back, so the refusal stays as silent to the page as it was.
 *
 * Why a floor between notices: a document can ask in a loop, and every attempt would otherwise
 * cross the IPC boundary and re-render the strip. The reader learns nothing from the thousandth.
 */
const NOTICE_MIN_INTERVAL_MS = 2_000
const noticedAtByGrantId = new Map<string, number>()

onDocPreviewGrantRevoked((grant) => noticedAtByGrantId.delete(grant.id))

export function noticeDocPreviewDownloadBlocked(guest: Electron.WebContents): void {
  const grantId = readDocPreviewGuestBoundGrantId(guest)
  // Nothing to route a notice to: no shell is showing this contents as a preview.
  if (grantId === null) {
    return
  }
  const now = Date.now()
  // Doubles as the expiry check, so what survives is exactly "noticed inside the window", and a
  // grant that stops downloading stops being remembered.
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
