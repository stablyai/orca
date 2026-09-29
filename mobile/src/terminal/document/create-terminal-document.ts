import { createTerminalDocumentScope } from './document-scope'
import { cancelDocumentFrames } from './document-frame-registry'
import { startFitScale, stopFitScale } from './fit-scale'
import { handleMsg } from './host-message-router'
import { startHostNotify, stopHostNotify } from './host-notify'
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

/**
 * One terminal document, started.
 *
 * The program both hosts run: the WebView loads it as a bundled script that calls this once with no
 * host, and the page imports it and calls it per mount with its own hooks. A call owns everything
 * it touches — the scope below is local to it — so two documents on one page are two terminals,
 * and a callback left over from a mount that has gone reads the scope it closed over rather than
 * the live one.
 *
 * The sequence is here rather than derived from a list, because it *is* the document's shape:
 * each start reads the elements and installs the listeners its module owns, and the stops undo
 * them in reverse so nothing is torn down under something still using it. The frames go last,
 * after every stop that might still be holding one (ruling 21).
 */
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

/**
 * Every module's start, in the order the document runs them.
 *
 * A start that throws has left the ones before it holding a document listener or the host's error
 * reporter, and there is no handle for anyone to stop with, so the undo runs here. Every stop is a
 * no-op against a start that never ran (ruling 21), which is what makes the whole sequence the
 * right undo for a partial one.
 *
 * Exported because a test that drives one module still needs the elements and listeners the others
 * put in place, and the order is not a thing to write twice.
 */
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
    startMessageBridge(scope)
  } catch (error) {
    stopTerminalDocument(scope)
    throw error
  }
}

/** The undo, in reverse, with the frames the document is still owed taken back last (ruling 21). */
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
