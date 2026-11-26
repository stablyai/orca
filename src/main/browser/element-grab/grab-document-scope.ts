import type { WebFrameMain } from 'electron'
import { GRAB_EXECUTION_REQUEST } from '../../../shared/browser/element-grab/grab-execution-protocol'

export type GrabDocumentScope = {
  current: boolean
  frame: WebFrameMain | null
  documentId: string | null
  /** The picker that is live in the page. A replacement arm takes this only once it succeeds. */
  overlayId: string | null
  /** An arm the page is still running; a failed one leaves `overlayId`'s picker live. */
  pendingOverlayId: string | null
}

export function sendPrivate(frame: WebFrameMain | null, message: unknown): void {
  try {
    frame?.send(GRAB_EXECUTION_REQUEST, message)
  } catch {
    /* The document may be gone. */
  }
}

/** Retires the live picker and any arm still running, so a cancel mid-arm leaves neither behind. */
export function retireGrabOverlay(scope: GrabDocumentScope): void {
  if (scope.documentId) {
    for (const overlayId of [scope.overlayId, scope.pendingOverlayId]) {
      if (overlayId) {
        sendPrivate(scope.frame, { kind: 'retire', documentId: scope.documentId, overlayId })
      }
    }
  }
  scope.overlayId = null
  scope.pendingOverlayId = null
}

/** Retires one picker only while it is still the live one; a successor that replaced it stays. */
export function retireGrabOverlayIfLive(scope: GrabDocumentScope, overlayId: string | null): void {
  if (overlayId && scope.documentId && scope.overlayId === overlayId) {
    sendPrivate(scope.frame, { kind: 'retire', documentId: scope.documentId, overlayId })
    scope.overlayId = null
  }
}

export function restoreGrabCapture(scope: GrabDocumentScope, captureId: string): void {
  if (scope.documentId) {
    sendPrivate(scope.frame, { kind: 'restoreCapture', documentId: scope.documentId, captureId })
  }
}
