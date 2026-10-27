import { useCallback } from 'react'
import { isTerminalOscLinkRanges } from '../../../src/shared/terminal-osc-link-ranges'
import * as nativeChatTerminalStream from './native-chat/mobile-native-chat-terminal-stream'
import {
  createMobileTerminalStreamLifetime,
  subscribeMobileTerminalSafely
} from './mobile-terminal-stream-subscribe'
import { mobileTerminalSnapshotByteBudget } from './terminal-snapshot-byte-budget'
import {
  readTerminalViewportDims,
  runTerminalViewportFitPass
} from './mobile-terminal-viewport-resubscribe'
import { updateTerminalCwdFromStreamEvent } from './mobile-session-route-helpers'
import type { MobileSessionTerminalSubscriptionFoundationModel } from './use-mobile-session-terminal-subscription-foundation'

const snapshotByteBudget = mobileTerminalSnapshotByteBudget()

export function useMobileSessionTerminalSubscription(
  scope: MobileSessionTerminalSubscriptionFoundationModel
) {
  const {
    client,
    clientId,
    setTerminalModes,
    terminalCwdRef,
    viewportRef,
    viewportMeasuredRef,
    terminalUnsubsRef,
    subscribingHandlesRef,
    leaseOnlyHandlesRef,
    initializedHandlesRef,
    terminalDiagnosticsRef,
    viewportResubscribeBudgetRef,
    webReadyHandlesRef,
    activeHandleRef,
    subscribeSeqRef,
    layoutSeqRef,
    terminalFrameRef,
    scheduleDelayedAction,
    showToast,
    markNativeChatInputLeaseReady,
    showNativeChatRef,
    getTerminalRef,
    unsubscribeTerminal,
    unsubscribeTerminalRef,
    signalTerminalInventoryRecovery
  } = scope
  const subscribeToTerminal = useCallback(
    (handle: string): boolean => {
      const diagnostics = terminalDiagnosticsRef.current
      const logSkippedGate = (reason: string) =>
        diagnostics.streamSkipped(handle, reason, handle === activeHandleRef.current)
      if (!client) {
        logSkippedGate('no-client')
        return false
      }
      if (clientId === null) {
        logSkippedGate('no-client-identity')
        return false
      }
      if (terminalUnsubsRef.current.has(handle)) {
        logSkippedGate('already-subscribed')
        return false
      }
      if (subscribingHandlesRef.current.has(handle)) {
        logSkippedGate('subscribe-in-flight')
        return false
      }
      const covered = nativeChatTerminalStream.isTerminalCoveredByNativeChat(
        showNativeChatRef.current,
        activeHandleRef.current,
        handle
      )
      // Covered chat can hold a lease without a mounted WebView; gate readiness only for rendered terminals.
      if (!covered) {
        const ref = getTerminalRef(handle)
        if (!ref) {
          logSkippedGate('no-webview-ref')
          return false
        }
        if (!webReadyHandlesRef.current.has(handle)) {
          logSkippedGate('webview-not-ready')
          return false
        }
        const frame = terminalFrameRef.current
        if (!viewportMeasuredRef.current) {
          // Wait for first frame layout: document ready can arrive before its fitted dimensions.
          if (!frame) {
            logSkippedGate('frame-not-laid-out')
            return false
          }
          // Use the document’s measured cell box so the host serializes scrollback at phone dimensions.
          const dims = ref.fitDimensions(frame)
          diagnostics.viewportMeasured(handle, dims, frame.height)
          if (dims) {
            viewportRef.current = dims
            viewportMeasuredRef.current = true
          }
        }
      }

      subscribingHandlesRef.current.add(handle)
      if (covered) {
        leaseOnlyHandlesRef.current.add(handle)
      } else {
        leaseOnlyHandlesRef.current.delete(handle)
      }
      const seq = (subscribeSeqRef.current.get(handle) ?? 0) + 1
      subscribeSeqRef.current.set(handle, seq)
      diagnostics.streamArmed(handle, seq, viewportRef.current)
      const sentViewport = nativeChatTerminalStream.mobileNativeChatSubscribeViewport(
        covered,
        viewportRef.current
      )

      const lifetime = createMobileTerminalStreamLifetime({
        isSubscriptionCurrent: () => subscribeSeqRef.current.get(handle) === seq,
        currentTerminal: () => getTerminalRef(handle),
        scheduleDelayedAction,
        onEnd: () => {
          unsubscribeTerminalRef.current(handle)
          signalTerminalInventoryRecovery()
        }
      })

      const adoptDisplayMode = (displayMode: unknown) => {
        if (displayMode !== 'auto' && displayMode !== 'phone' && displayMode !== 'desktop') {
          return
        }
        // Reuse mode Map on no-op frames so every stream pass cannot rerender the route.
        setTerminalModes((prev) =>
          prev.get(handle) === displayMode ? prev : new Map(prev).set(handle, displayMode)
        )
      }

      // Send viewport in subscribe so host fitting precedes snapshot serialization without a focus/fit race.
      const stopStream = subscribeMobileTerminalSafely(
        client,
        {
          terminal: handle,
          client: { id: clientId, type: 'mobile' as const },
          viewport: sentViewport,
          capabilities: nativeChatTerminalStream.mobileNativeChatTerminalCapabilities(covered),
          // Omit absent native budgets to preserve older hosts’ subscribe shape.
          ...(snapshotByteBudget === undefined ? {} : { snapshotByteBudget })
        },
        (result) => {
          if (!lifetime.isCurrent()) {
            return
          }
          const data = result as Record<string, unknown>
          diagnostics.firstStreamEvent(handle, seq, data.type)
          if (data.type === 'end' || data.type === 'error') {
            lifetime.end()
            return
          }
          if (data.type === 'subscribed') {
            markNativeChatInputLeaseReady(handle)
            return
          }
          // Covered streams keep input ownership without changing hidden xterm state; returning view gets fresh history.
          if (
            nativeChatTerminalStream.isTerminalCoveredByNativeChat(
              showNativeChatRef.current,
              activeHandleRef.current,
              handle
            )
          ) {
            return
          }
          // Reject superseded resize sequences; fresh scrollback resets the mark or reconnect can blank the terminal.
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
              return
            }
            layoutSeqRef.current.set(handle, eventSeq)
          } else if (eventSeq != null && data.type === 'scrollback') {
            layoutSeqRef.current.set(handle, eventSeq)
          }
          if (data.type === 'scrollback') {
            diagnostics.streamScrollback(handle, seq, eventSeq, data)
            if (initializedHandlesRef.current.has(handle)) {
              return
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
              return
            }
            const frame = terminalFrameRef.current
            const kittyFlags = data.kittyKeyboardFlags
            ref.init({ cols, rows, initialData, preserveScroll: true, oscLinks, kittyFlags, frame })
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
              return
            }
            if (!initializedHandlesRef.current.has(handle)) {
              console.log('[fit][session] data RECEIVED before scrollback', {
                handle: handle.slice(-8),
                chunkLen: typeof data.chunk === 'string' ? data.chunk.length : 0
              })
            }
            dataRef.write(data.chunk as string)
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
              getTerminalRef(handle)?.init({
                cols,
                rows,
                initialData: serialized,
                preserveScroll: true,
                oscLinks,
                kittyFlags: data.kittyKeyboardFlags,
                frame: terminalFrameRef.current
              })
            } else {
              getTerminalRef(handle)?.resize(cols, rows, terminalFrameRef.current)
            }
            adoptDisplayMode(data.displayMode)
            lifetime.scheduleSettledFit(getTerminalRef(handle))
          }
        },
        lifetime.end
      )

      const unsub = lifetime.wrapUnsubscribe(stopStream)
      if (lifetime.isCurrent()) {
        terminalUnsubsRef.current.set(handle, unsub)
      } else {
        unsub()
      }
      subscribingHandlesRef.current.delete(handle)
      return true
    },
    [
      client,
      clientId,
      getTerminalRef,
      markNativeChatInputLeaseReady,
      scheduleDelayedAction,
      showToast,
      signalTerminalInventoryRecovery
    ]
  )
  return {
    subscribeToTerminal
  }
}

export type MobileSessionTerminalSubscriptionModel =
  MobileSessionTerminalSubscriptionFoundationModel &
    ReturnType<typeof useMobileSessionTerminalSubscription>
