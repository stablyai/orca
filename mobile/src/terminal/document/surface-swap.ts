import { disposeTermObservers } from './write-queue'
import { attachSurfaceEventHandlers } from './surface-touch-gestures'
import { scope, type TerminalDocumentTerminal } from './document-scope'

/** The surfaces and terminal a swap is replacing, handed back to whoever commits it. */
export type TerminalSurfaceSwap = {
  oldTerm: TerminalDocumentTerminal | null
  oldSurface: HTMLElement | null
  nextSurface: HTMLElement
}

export function beginTerminalSurfaceSwap() {
  // Why: a superseded hidden replacement must not remain between the last
  // painted surface and the newest one, or the newest commits below the viewport.
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
  disposeTermObservers()
  swap.nextSurface.id = 'terminal-surface'
  swap.nextSurface.style.visibility = 'hidden'
  swap.nextSurface.style.position = 'absolute'
  swap.nextSurface.style.left = '0'
  swap.nextSurface.style.top = '0'
  document.getElementById('terminal-container')!.appendChild(swap.nextSurface)
  scope.surface = swap.nextSurface
  scope.pendingSurface = swap.nextSurface
  attachSurfaceEventHandlers(scope.surface)
  swap.oldSurface!.removeAttribute('id')
  return swap
}

export function commitTerminalSurfaceSwap(
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

// Why: phone-fit startup can issue several init() calls before xterm finishes replaying, so the
// last painted surface is tracked apart from its replacement — on the scope (ruling 21), because
// the page mounts this module more than once and a second mount must not inherit the first's.
export function startSurfaceSwap() {
  scope.committedSurface = scope.surface
}
