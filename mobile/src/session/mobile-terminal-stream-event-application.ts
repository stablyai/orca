import { isTerminalStreamEvent } from '../transport/mobile-terminal-stream-record'
import { isTerminalOscLinkRanges } from '../../../src/shared/terminal-osc-link-ranges'
import * as nativeChatTerminalStream from './native-chat/mobile-native-chat-terminal-stream'
import {
  readTerminalViewportDims,
  runTerminalViewportFitPass
} from './mobile-terminal-viewport-resubscribe'
import { updateTerminalCwdFromStreamEvent } from './mobile-session-route-helpers'
import type { createMobileTerminalStreamLifetime } from './mobile-terminal-stream-subscribe'
import type { MobileSessionTerminalSubscriptionFoundationModel } from './use-mobile-session-terminal-subscription-foundation'

function afterTerminalApplication(
  apply: (applied: (error?: Error) => void) => void,
  onApplied?: () => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    apply((error) => {
      if (error) {
        reject(error)
        return
      }
      try {
        onApplied?.()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
}

export function createMobileTerminalStreamEventListener({
  scope,
  handle,
  seq,
  lifetime,
  sentViewport,
  subscribeToTerminal
}: {
  scope: MobileSessionTerminalSubscriptionFoundationModel
  handle: string
  seq: number
  lifetime: ReturnType<typeof createMobileTerminalStreamLifetime>
  sentViewport: { cols: number; rows: number } | undefined
  subscribeToTerminal: (handle: string) => boolean
}) {
  const {
    markNativeChatInputLeaseReady,
    setTerminalModes,
    terminalCwdRef,
    initializedHandlesRef,
    terminalDiagnosticsRef,
    viewportResubscribeBudgetRef,
    activeHandleRef,
    subscribeSeqRef,
    layoutSeqRef,
    scheduleDelayedAction,
    showToast,
    showNativeChatRef,
    getTerminalRef,
    unsubscribeTerminal,
    terminalUnsubsRef
  } = scope
  const { viewportRef, viewportMeasuredRef, terminalFrameRef } =
    scope.getTerminalPaneViewport?.(handle) ?? scope
  const diagnostics = terminalDiagnosticsRef.current
  const adoptDisplayMode = (displayMode: unknown) => {
    if (displayMode !== 'auto' && displayMode !== 'phone' && displayMode !== 'desktop') {
      return
    }
    // Reuse mode Map on no-op frames so every stream pass cannot rerender the route.
    setTerminalModes((prev) =>
      prev.get(handle) === displayMode ? prev : new Map(prev).set(handle, displayMode)
    )
  }

  let awaitingInitialSnapshot = true
  return (result: unknown) => {
    if (!lifetime.isCurrent()) {
      return
    }
    const data = result
    if (!isTerminalStreamEvent(data)) {
      return
    }
    diagnostics.firstStreamEvent(handle, seq, data.type)
    if (data.type === 'end' || data.type === 'error') {
      lifetime.end()
      return
    }
    if (data.type === 'subscribed') {
      awaitingInitialSnapshot = true
      if (typeof data.seq === 'number') {
        layoutSeqRef.current.set(handle, data.seq)
      } else {
        layoutSeqRef.current.delete(handle)
      }
      markNativeChatInputLeaseReady(handle)
      return
    }
    // Retire visible output before the existing cover reconciler acquires its input-only lease.
    if (
      nativeChatTerminalStream.isTerminalCoveredByNativeChat(
        showNativeChatRef.current,
        activeHandleRef.current,
        handle
      )
    ) {
      if (!scope.leaseOnlyHandlesRef.current.has(handle)) {
        lifetime.end()
      }
      return
    }
    // Layout versions and scrollback output offsets are separate sequence domains.
    const eventSeq = typeof data.seq === 'number' ? data.seq : null
    if (eventSeq != null && data.type === 'resized') {
      const last = layoutSeqRef.current.get(handle)
      if (last != null && eventSeq < last && last - eventSeq <= 20) {
        console.log('[fit][session] DROP-stale-seq', {
          handle: handle.slice(-8),
          type: data.type,
          eventSeq,
          lastSeq: last,
          cols: data.cols,
          rows: data.rows,
          displayMode: data.displayMode
        })
        return Promise.resolve()
      }
      layoutSeqRef.current.set(handle, eventSeq)
    }
    if (data.type === 'scrollback') {
      diagnostics.streamScrollback(handle, seq, eventSeq, data)
      if (
        initializedHandlesRef.current.has(handle) &&
        !awaitingInitialSnapshot &&
        data.reason !== 'ack-pending-overflow'
      ) {
        return Promise.resolve()
      }
      updateTerminalCwdFromStreamEvent(handle, data, terminalCwdRef.current)
      const { hostCols, hostRows } = readTerminalViewportDims(data)
      // Keep absent dimensions unknown; invented 80x24 can never match phone size and causes a refit loop.
      const cols = hostCols ?? viewportRef.current?.cols ?? 80
      const rows = hostRows ?? viewportRef.current?.rows ?? 24
      const initialData = typeof data.serialized === 'string' ? data.serialized : ''
      const oscLinks = isTerminalOscLinkRanges(data.oscLinks) ? data.oscLinks : undefined
      const ref = getTerminalRef(handle)
      // Mark initialized only after init reaches the WebView or later snapshots are discarded while it stays blank.
      if (!ref) {
        console.log('[fit][session] scrollback DROPPED — no terminal ref', {
          handle: handle.slice(-8),
          cols,
          rows
        })
        lifetime.end()
        return
      }
      const frame = terminalFrameRef.current
      const kittyFlags = data.kittyKeyboardFlags
      awaitingInitialSnapshot = false
      return afterTerminalApplication(
        (applied) =>
          ref.init(
            { cols, rows, initialData, preserveScroll: true, oscLinks, kittyFlags, frame },
            applied
          ),
        () => {
          if (!lifetime.isCurrent() || getTerminalRef(handle) !== ref) {
            return
          }
          initializedHandlesRef.current.add(handle)
          adoptDisplayMode(data.displayMode)
          // Refit after DOM settles because init can see transient scrollWidth.
          lifetime.scheduleSettledFit(ref)
          // Measure viewport-less subscriptions after init, then retry within the bounded per-handle budget.
          runTerminalViewportFitPass({
            handle,
            seq,
            hostCols,
            hostRows,
            displayMode: typeof data.displayMode === 'string' ? data.displayMode : null,
            sentViewport: sentViewport ?? null,
            budget: viewportResubscribeBudgetRef.current,
            diagnostics,
            viewportRef,
            viewportMeasuredRef,
            subscribeSeqRef,
            terminalUnsubsRef,
            terminalFrameRef,
            getTerminalRef,
            unsubscribeTerminal,
            subscribeToTerminal,
            scheduleDelayedAction,
            showToast
          })
        }
      )
    } else if (data.type === 'metadata') {
      updateTerminalCwdFromStreamEvent(handle, data, terminalCwdRef.current)
    } else if (data.type === 'data') {
      updateTerminalCwdFromStreamEvent(handle, data, terminalCwdRef.current)
      // Missing refs explain input-working/blank-output states after unmount or missing scrollback.
      const dataRef = getTerminalRef(handle)
      if (!dataRef) {
        console.log('[fit][session] data DROPPED — no terminal ref', {
          handle: handle.slice(-8),
          chunkLen: typeof data.chunk === 'string' ? data.chunk.length : 0,
          initialized: initializedHandlesRef.current.has(handle)
        })
        lifetime.end()
        return
      }
      if (!initializedHandlesRef.current.has(handle)) {
        console.log('[fit][session] data RECEIVED before scrollback', {
          handle: handle.slice(-8),
          chunkLen: typeof data.chunk === 'string' ? data.chunk.length : 0
        })
      }
      return afterTerminalApplication((applied) =>
        dataRef.write(typeof data.chunk === 'string' ? data.chunk : '', applied)
      )
    } else if (data.type === 'resized') {
      updateTerminalCwdFromStreamEvent(handle, data, terminalCwdRef.current)
      // Width reflow needs full-buffer reinit; geometry-only events just resize.
      const viewport = viewportMeasuredRef.current ? viewportRef.current : null
      const [cols, rows] = viewportResubscribeBudgetRef.current.observeResize(
        handle,
        data,
        viewport
      )
      const serialized = typeof data.serialized === 'string' ? data.serialized : null
      diagnostics.streamResized(handle, seq, eventSeq, data, getTerminalRef(handle) != null)
      const oscLinks = isTerminalOscLinkRanges(data.oscLinks) ? data.oscLinks : undefined
      if (serialized != null) {
        const ref = getTerminalRef(handle)
        if (!ref) {
          lifetime.end()
          return
        }
        return afterTerminalApplication(
          (applied) =>
            ref.init(
              {
                cols,
                rows,
                initialData: serialized,
                preserveScroll: true,
                oscLinks,
                kittyFlags: data.kittyKeyboardFlags,
                frame: terminalFrameRef.current
              },
              applied
            ),
          () => {
            if (!lifetime.isCurrent() || getTerminalRef(handle) !== ref) {
              return
            }
            adoptDisplayMode(data.displayMode)
            lifetime.scheduleSettledFit(ref)
          }
        )
      }
      getTerminalRef(handle)?.resize(cols, rows, terminalFrameRef.current)

      adoptDisplayMode(data.displayMode)
      lifetime.scheduleSettledFit(getTerminalRef(handle))
    }
  }
}
