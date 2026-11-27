import type { GrabExecutionResult } from '../../../shared/browser/element-grab/grab-execution-protocol'
import { sendPrivate, type GrabDocumentScope } from './grab-document-scope'

/** A new document's scope: no picker live and no arm running yet. */
export function freshGrabDocumentScope(): GrabDocumentScope {
  return { current: true, frame: null, documentId: null, overlayId: null, pendingOverlayId: null }
}

/**
 * Settles an arm the page was running (`result` null when it never reached the page or timed out).
 * A failed arm leaves the previous picker live there, so only a successful one takes over
 * `overlayId`. Any other outcome retires the arm in the page, so one still running there (its
 * caller already told it failed) cannot go live later.
 */
export function settleGrabOverlayArm(
  scope: GrabDocumentScope,
  armId: string,
  result: GrabExecutionResult | null
): void {
  if (scope.pendingOverlayId !== armId) {
    return
  }
  scope.pendingOverlayId = null
  if (result?.ok && result.value === true) {
    scope.overlayId = armId
  } else if (scope.documentId) {
    sendPrivate(scope.frame, { kind: 'retire', documentId: scope.documentId, overlayId: armId })
  }
}
