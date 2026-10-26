import { elementInRoot } from './document-host-seams'
import { disposeTermObservers } from './write-queue'
import { attachSurfaceEventHandlers } from './surface-touch-gestures'
import type { TerminalDocumentScope, TerminalDocumentTerminal } from './document-scope'

export type TerminalSurfaceSwap = {
  oldTerm: TerminalDocumentTerminal | null
  oldSurface: HTMLElement | null
  nextSurface: HTMLElement
}

export function beginTerminalSurfaceSwap(scope: TerminalDocumentScope) {
  // Remove superseded hidden surfaces so the newest replacement cannot commit below the viewport.
  if (scope.pendingSurface) {
    try {
      scope.pendingSurface.remove()
    } catch {}
    if (scope.pendingTerm) {
      try {
        scope.pendingTerm.dispose()
      } catch {}
    }
    scope.pendingSurface = null
    scope.pendingTerm = null
  }
  const swap = {
    oldTerm: scope.committedTerm,
    oldSurface: scope.committedSurface,
    nextSurface: document.createElement('div')
  }
  disposeTermObservers(scope)
  swap.nextSurface.id = 'terminal-surface'
  swap.nextSurface.style.visibility = 'hidden'
  swap.nextSurface.style.position = 'absolute'
  swap.nextSurface.style.left = '0'
  swap.nextSurface.style.top = '0'
  elementInRoot(scope.root, 'terminal-container')!.appendChild(swap.nextSurface)
  scope.surface = swap.nextSurface
  scope.pendingSurface = swap.nextSurface
  attachSurfaceEventHandlers(scope, scope.surface)
  swap.oldSurface!.removeAttribute('id')
  return swap
}

export function commitTerminalSurfaceSwap(
  scope: TerminalDocumentScope,
  swap: TerminalSurfaceSwap,
  nextTerm: TerminalDocumentTerminal
) {
  swap.nextSurface.style.visibility = 'visible'
  swap.nextSurface.style.position = ''
  swap.nextSurface.style.left = ''
  swap.nextSurface.style.top = ''
  swap.oldSurface!.remove()
  if (swap.oldTerm) {
    swap.oldTerm.dispose()
  }
  scope.committedTerm = nextTerm
  scope.committedSurface = swap.nextSurface
  scope.pendingTerm = null
  scope.pendingSurface = null
}

// Startup may overlap replays; track the last painted surface separately from its hidden replacement per document.
export function startSurfaceSwap(scope: TerminalDocumentScope) {
  scope.surface = elementInRoot(scope.root, 'terminal-surface')
  scope.committedSurface = scope.surface
}
