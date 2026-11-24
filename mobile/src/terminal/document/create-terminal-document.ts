import { createTerminalDocumentScope } from './document-scope'
import { cancelDocumentFrames } from './document-frame-registry'
import { startFitScale, stopFitScale } from './viewport/fit-scale'
import { handleMsg } from './host-bridge/host-message-router'
import { reportEngineError, startHostNotify, stopHostNotify } from './host-bridge/host-notify'
import { startMessageBridge, stopMessageBridge } from './host-bridge/message-bridge'
import { stopNormalBufferSmoothScroll } from './viewport/normal-buffer-smooth-scroll'
import { startSelectionMenuButtons } from './selection/selection-menu-buttons'
import { stopSelectionOverlay } from './selection/selection-overlay'
import { startSelectionStateAndEviction } from './selection/selection-state-and-eviction'
import { startSurfaceSwap } from './engine/surface-swap'
import { startSurfaceTouchGestures } from './surface-input/surface-touch-gestures'
import { stopSurfaceTouchGestures } from './surface-input/surface-touch-gesture-stop'
import { startTapDispatch, stopTapDispatch } from './surface-input/tap-dispatch'
import { stopTerminalInit } from './engine/terminal-init'
import { startTextScaling } from './viewport/text-scaling'
import { stopViewportTransform } from './viewport/viewport-transform'
import { startWebglRecovery, stopWebglRecovery } from './engine/webgl-recovery'
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
