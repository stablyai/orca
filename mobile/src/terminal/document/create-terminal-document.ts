import { createTerminalDocumentScope } from './document-scope'
import { cancelDocumentFrames } from './document-frame-registry'
import { startFitScale, stopFitScale } from './fit-scale'
import { handleMsg } from './host-message-router'
import { reportEngineError, startHostNotify, stopHostNotify } from './host-notify'
import { startMessageBridge, stopMessageBridge } from './message-bridge'
import { stopNormalBufferSmoothScroll } from './normal-buffer-smooth-scroll'
import { startSelectionMenuButtons } from './selection-menu-buttons'
import { stopSelectionOverlay } from './selection-overlay'
import { startSelectionStateAndEviction } from './selection-state-and-eviction'
import { startSurfaceSwap } from './surface-swap'
import { startSurfaceTouchGestures, stopSurfaceTouchGestures } from './surface-touch-gestures'
import { startTapDispatch, stopTapDispatch } from './tap-dispatch'
import { stopTerminalInit } from './terminal-init'
import { startTextScaling } from './text-scaling'
import { stopViewportTransform } from './viewport-transform'
import { startWebglRecovery, stopWebglRecovery } from './webgl-recovery'
import type { TerminalDocumentScope } from './document-scope'
import type { TerminalDocument, TerminalDocumentHost } from './document-host-seams'

// Own scope per document so overlapping mounts and stale callbacks cannot share state.
// Start in dependency order, stop in reverse, and cancel frames after every stop that could still hold one.
export function createTerminalDocument(host: TerminalDocumentHost = {}): TerminalDocument {
  const scope = createTerminalDocumentScope(host)
  startTerminalDocument(scope)
  return {
    send: (message) => {
      handleMsg(scope, message)
    },
    stop: () => {
      stopTerminalDocument(scope)
    }
  }
}

// If startup throws before returning a handle, unwind here; each stop tolerates a start that never ran.
export function startTerminalDocument(scope: TerminalDocumentScope) {
  try {
    startSurfaceSwap(scope)
    startTextScaling(scope)
    startFitScale(scope)
    startWebglRecovery(scope)
    startHostNotify(scope)
    startSelectionStateAndEviction(scope)
    startTapDispatch(scope)
    startSelectionMenuButtons(scope)
    startSurfaceTouchGestures(scope)
    startMessageBridge(scope)?.catch(failDeferredStartup.bind(null, scope))
  } catch (error) {
    stopTerminalDocument(scope)
    throw error
  }
}

function failDeferredStartup(scope: TerminalDocumentScope, error: unknown) {
  stopTerminalDocument(scope)
  reportEngineError(
    scope,
    'terminal startup failed',
    error instanceof Error ? error.message : String(error),
    true
  )
}

export function stopTerminalDocument(scope: TerminalDocumentScope) {
  stopMessageBridge(scope)
  stopSurfaceTouchGestures(scope)
  stopTapDispatch(scope)
  stopSelectionOverlay(scope)
  stopNormalBufferSmoothScroll(scope)
  stopHostNotify(scope)
  stopTerminalInit(scope)
  stopWebglRecovery(scope)
  stopFitScale(scope)
  stopViewportTransform(scope)
  cancelDocumentFrames(scope)
}
