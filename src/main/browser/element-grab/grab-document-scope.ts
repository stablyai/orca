import type { WebFrameMain } from 'electron'
import { GRAB_EXECUTION_REQUEST } from '../../../shared/browser/element-grab/grab-execution-protocol'

export type GrabDocumentScope = {
  current: boolean
  frame: WebFrameMain | null
  documentId: string | null
  overlayId: string | null
}
export function sendPrivate(frame: WebFrameMain | null, message: unknown): void {
  try {
    frame?.send(GRAB_EXECUTION_REQUEST, message)
  } catch {
    /* The document may be gone. */
  }
}

export function retireGrabOverlay(scope: GrabDocumentScope): void {
  if (scope.documentId && scope.overlayId) {
    sendPrivate(scope.frame, {
      kind: 'retire',
      documentId: scope.documentId,
      overlayId: scope.overlayId
    })
    scope.overlayId = null
  }
}

export function restoreGrabCapture(scope: GrabDocumentScope, captureId: string): void {
  if (scope.documentId) {
    sendPrivate(scope.frame, { kind: 'restoreCapture', documentId: scope.documentId, captureId })
  }
}
