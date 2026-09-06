import { isTerminalOscLinkRanges } from '../../../src/shared/terminal-osc-link-ranges'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import type {
  HostSessionTerminalOperations,
  HostSessionTerminalStreamEvent
} from './host-session-terminal-operations'
import {
  hostSessionTerminalAcknowledgement,
  hostSessionTerminalData
} from './host-session-terminal-event-presentation'
import { updateTerminalCwdFromStreamEvent } from './mobile-session-route-helpers'
import type { MobileDisplayMode } from './mobile-session-route-types'
import type { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import {
  readTerminalViewportDims,
  runTerminalViewportFitPass,
  type TerminalViewportDims,
  type TerminalViewportResubscribeBudget
} from './mobile-terminal-viewport-resubscribe'

type MutableRef<T> = { current: T }

type HostSessionTerminalStreamPresentation = {
  event: HostSessionTerminalStreamEvent
  handle: string
  subscribeSequence: number
  isCovered: () => boolean
  unsubscribe: (handle: string) => void
  markInputLeaseReady: (handle: string) => void
  signalTerminalInventoryRecovery: () => void
  layoutSequences: Map<string, number>
  terminalCwds: Map<string, string>
  getTerminalRef: (handle: string | null) => TerminalWebViewHandle | undefined
  operations: HostSessionTerminalOperations
  setDisplayMode: (handle: string, mode: MobileDisplayMode) => void
  diagnostics: MobileTerminalDiagnostics
  scheduleDelayedAction: (action: () => void, delayMs: number) => void
  viewportRef: MutableRef<TerminalViewportDims | null>
  viewportMeasuredRef: MutableRef<boolean>
  terminalFrameHeightRef: MutableRef<number>
  subscribeSeqRef: MutableRef<Map<string, number>>
  initializedHandlesRef: MutableRef<Set<string>>
  terminalUnsubsRef: MutableRef<Map<string, () => void>>
  viewportResubscribeBudget: TerminalViewportResubscribeBudget
  showToast: (message: string, durationMs?: number) => void
  subscribe: (handle: string) => void
}

export function presentHostSessionTerminalStreamEvent(
  context: HostSessionTerminalStreamPresentation
): void {
  if (context.subscribeSeqRef.current.get(context.handle) !== context.subscribeSequence) {
    return
  }
  const data = context.event as unknown as Record<string, unknown>
  context.diagnostics.firstStreamEvent(context.handle, context.subscribeSequence, data.type)
  if (data.type === 'end' || data.type === 'error') {
    context.unsubscribe(context.handle)
    // Why: a dead PTY leaves a stale tab until the next 60s sweep unless the list is re-read now.
    context.signalTerminalInventoryRecovery()
    return
  }
  if (data.type === 'subscribed') {
    context.markInputLeaseReady(context.handle)
    return
  }
  // Why: a covered terminal keeps only its input lease; returning resubscribes its visible xterm.
  if (context.isCovered()) {
    return
  }

  const eventSequence = typeof data.seq === 'number' ? data.seq : null
  if (dropStaleResize(context, data, eventSequence)) {
    return
  }
  if (data.type === 'scrollback') {
    presentScrollback(context, data, eventSequence)
  } else if (data.type === 'metadata') {
    updateTerminalCwdFromStreamEvent(context.handle, data, context.terminalCwds)
    setDisplayMode(context, data)
  } else if (data.type === 'data') {
    presentOutput(context, data)
  } else if (data.type === 'resized') {
    presentResize(context, data, eventSequence)
  }
}

function dropStaleResize(
  context: HostSessionTerminalStreamPresentation,
  data: Record<string, unknown>,
  eventSequence: number | null
): boolean {
  if (eventSequence != null && data.type === 'resized') {
    const last = context.layoutSequences.get(context.handle)
    if (last != null && eventSequence < last && last - eventSequence <= 20) {
      console.log('[fit][session] DROP-stale-seq', {
        type: data.type,
        eventSeq: eventSequence,
        lastSeq: last,
        cols: data.cols,
        rows: data.rows,
        displayMode: data.displayMode
      })
      return true
    }
    context.layoutSequences.set(context.handle, eventSequence)
  } else if (eventSequence != null && data.type === 'scrollback') {
    context.layoutSequences.set(context.handle, eventSequence)
  }
  return false
}

function presentScrollback(
  context: HostSessionTerminalStreamPresentation,
  data: Record<string, unknown>,
  eventSequence: number | null
): void {
  context.diagnostics.streamScrollback(
    context.handle,
    context.subscribeSequence,
    eventSequence,
    data
  )
  if (context.initializedHandlesRef.current.has(context.handle)) {
    return
  }
  updateTerminalCwdFromStreamEvent(context.handle, data, context.terminalCwds)
  const { hostCols, hostRows } = readTerminalViewportDims(data)
  // Why: absent host dims must not be coerced into a comparable size — 80x24
  // never equals a phone viewport and armed a zero-delay resubscribe loop (STA-3337).
  const cols = hostCols ?? context.viewportRef.current?.cols ?? 80
  const rows = hostRows ?? context.viewportRef.current?.rows ?? 24
  const serialized = hostSessionTerminalData(data.serialized)
  const ref = context.getTerminalRef(context.handle)
  if (!ref) {
    console.log('[fit][session] scrollback DROPPED — no terminal ref', {
      cols,
      rows
    })
    return
  }
  ref.init(
    cols,
    rows,
    serialized,
    false,
    isTerminalOscLinkRanges(data.oscLinks) ? data.oscLinks : undefined,
    hostSessionTerminalAcknowledgement(context.operations, context.handle, data.throughSequence)
  )
  context.initializedHandlesRef.current.add(context.handle)
  setDisplayMode(context, data)
  context.scheduleDelayedAction(() => context.getTerminalRef(context.handle)?.resetZoom(), 200)
  if (data.displayMode === 'desktop') {
    return
  }
  // Why: first subscribe has no viewport (xterm not loaded yet), so measure after init
  // and resubscribe so the server can phone-fit — bounded per handle so a
  // non-converging host degrades visibly instead of hot-looping (STA-3337).
  runTerminalViewportFitPass({
    handle: context.handle,
    seq: context.subscribeSequence,
    hostCols,
    hostRows,
    budget: context.viewportResubscribeBudget,
    diagnostics: context.diagnostics,
    viewportRef: context.viewportRef,
    viewportMeasuredRef: context.viewportMeasuredRef,
    subscribeSeqRef: context.subscribeSeqRef,
    initializedHandlesRef: context.initializedHandlesRef,
    terminalUnsubsRef: context.terminalUnsubsRef,
    terminalFrameHeightRef: context.terminalFrameHeightRef,
    getTerminalRef: context.getTerminalRef,
    unsubscribeTerminal: context.unsubscribe,
    subscribeToTerminal: context.subscribe,
    scheduleDelayedAction: context.scheduleDelayedAction,
    showToast: context.showToast
  })
}

function presentOutput(
  context: HostSessionTerminalStreamPresentation,
  data: Record<string, unknown>
): void {
  updateTerminalCwdFromStreamEvent(context.handle, data, context.terminalCwds)
  const ref = context.getTerminalRef(context.handle)
  if (!ref) {
    console.log('[fit][session] data DROPPED — no terminal ref', {
      chunkLen: hostSessionTerminalData(data.chunk).length,
      initialized: context.initializedHandlesRef.current.has(context.handle)
    })
    return
  }
  if (!context.initializedHandlesRef.current.has(context.handle)) {
    console.log('[fit][session] data RECEIVED before scrollback', {
      chunkLen: hostSessionTerminalData(data.chunk).length
    })
  }
  ref.write(
    hostSessionTerminalData(data.chunk),
    hostSessionTerminalAcknowledgement(context.operations, context.handle, data.throughSequence)
  )
}

function presentResize(
  context: HostSessionTerminalStreamPresentation,
  data: Record<string, unknown>,
  eventSequence: number | null
): void {
  updateTerminalCwdFromStreamEvent(context.handle, data, context.terminalCwds)
  // Why: a resize that already matches the measured viewport is convergence — it retires the fit budget.
  const [cols, rows] = context.viewportResubscribeBudget.observeResize(
    context.handle,
    data,
    context.viewportMeasuredRef.current ? context.viewportRef.current : null
  )
  const serialized = hostSessionTerminalData(data.serialized)
  context.diagnostics.streamResized(
    context.handle,
    context.subscribeSequence,
    eventSequence,
    data,
    context.getTerminalRef(context.handle) != null
  )
  const ref = context.getTerminalRef(context.handle)
  if (serialized.length > 0) {
    ref?.init(
      cols,
      rows,
      serialized,
      true,
      isTerminalOscLinkRanges(data.oscLinks) ? data.oscLinks : undefined,
      hostSessionTerminalAcknowledgement(context.operations, context.handle, data.throughSequence)
    )
  } else {
    ref?.resize(cols, rows)
  }
  setDisplayMode(context, data)
  context.scheduleDelayedAction(() => context.getTerminalRef(context.handle)?.resetZoom(), 200)
}

function setDisplayMode(
  context: HostSessionTerminalStreamPresentation,
  data: Record<string, unknown>
): void {
  if (
    data.displayMode === 'auto' ||
    data.displayMode === 'desktop' ||
    data.displayMode === 'phone'
  ) {
    context.setDisplayMode(context.handle, data.displayMode)
  }
}
