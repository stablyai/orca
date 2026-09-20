/**
 * The document's modules, and the two sequences that start and stop them.
 *
 * The document is one function scope, not a dependency graph: `runtime-constants` takes the
 * surface, `surface-swap` captures the surface it was handed, and `selection-state-and-eviction`
 * takes the overlay elements. Ruling 20 moved those out of the module bodies into start
 * functions; ruling 21 moved every mutable binding onto the scope, so what is left at module top
 * level is constants, functions and types. Importing this file therefore does nothing at all.
 *
 * That is what makes a second mount a second terminal. ES module bodies run once per page, so a
 * remount re-imports nothing: it resets the scope, then runs the same start sequence the WebView's
 * generated script runs once at parse, against the markup the host has just replanted.
 *
 * `message-bridge` is deliberately absent (ruling 19). It installs `window`/`document` `message`
 * listeners, and on the page those frames belong to the shell: the document would read a bridge
 * envelope as a terminal command. The component calls `handleMsg` instead, and re-arms the one
 * other thing that module does, the window-resize refit.
 *
 * `page-document-module-order.test.ts` holds these lists against
 * `scripts/terminal-document-module-order.mjs`, so the page and the WebView cannot run different
 * programs and a reordering edit cannot pass unread.
 */
import './document-host-seams'
import { cancelDocumentFrames, resetTerminalDocumentScope } from './document-scope'
import { startRuntimeConstants } from './runtime-constants'
import './query-reply'
import { startSurfaceSwap } from './surface-swap'
import { startTextScaling } from './text-scaling'
import { stopViewportTransform } from './viewport-transform'
import './terminal-theme'
import { stopFitScale } from './fit-scale'
import './mouse-mode-decset-scan'
import './write-queue'
import { startWebglRecovery, stopWebglRecovery } from './webgl-recovery'
import { stopTerminalInit } from './terminal-init'
import './reflow'
import { startHostNotify, stopHostNotify } from './host-notify'
import './host-message-router'
import { startSelectionStateAndEviction } from './selection-state-and-eviction'
import './mode-mirroring'
import './keyboard-avoidance-metrics'
import './term-observers'
import './viewport-cell'
import './mouse-report-cell'
import './mouse-input-encoding'
import { stopNormalBufferSmoothScroll } from './normal-buffer-smooth-scroll'
import './cell-geometry'
import './path-tap'
import './url-tap'
import './osc-link-tap'
import './surface-tap'
import './selection-range'
import { stopSelectionOverlay } from './selection-overlay'
import { startTapDispatch, stopTapDispatch } from './tap-dispatch'
import './wheel-scroll'
import './mouse-click-drag'
import { startSelectionMenuButtons } from './selection-menu-buttons'
import { startSurfaceTouchGestures, stopSurfaceTouchGestures } from './surface-touch-gestures'

/**
 * The scope's reset and every module's start function, in module order: what the WebView's
 * document runs once as its script is parsed, run here once per mount.
 */
export function startPageDocumentModules() {
  resetTerminalDocumentScope()
  // Unwound if one of them throws: a start that completed has already taken a listener or
  // installed the reporter, and leaving those behind would outlive the mount that never happened.
  // Only the starts with an undo need recording; the rest write scope fields the next reset
  // overwrites.
  const undo: (() => void)[] = []
  try {
    startRuntimeConstants()
    startSurfaceSwap()
    startTextScaling()
    startWebglRecovery()
    undo.unshift(stopWebglRecovery)
    startHostNotify()
    undo.unshift(stopHostNotify)
    startSelectionStateAndEviction()
    startTapDispatch()
    undo.unshift(stopTapDispatch)
    startSelectionMenuButtons()
    startSurfaceTouchGestures()
    undo.unshift(stopSurfaceTouchGestures)
  } catch (error) {
    for (const stop of undo) {
      stop()
    }
    throw error
  }
}

/**
 * The undo, in reverse module order: every listener that outlives the host element, and every
 * frame, timer and retry a module scheduled (ruling 21).
 */
export function stopPageDocumentModules() {
  // Last frames first: a module's own stop nulls the handle it holds, and this takes back every
  // frame the document is still owed, including the ones no module tracks by id.
  cancelDocumentFrames()
  stopSurfaceTouchGestures()
  stopTapDispatch()
  stopSelectionOverlay()
  stopNormalBufferSmoothScroll()
  stopHostNotify()
  stopTerminalInit()
  stopWebglRecovery()
  stopFitScale()
  stopViewportTransform()
}

export { scope } from './document-scope'
export { handleMsg } from './host-message-router'
export { adjustRowsForViewport, applyFitScale, clampPan } from './fit-scale'
export { repositionOverlay } from './selection-overlay'
export { updateTransform } from './viewport-transform'
