import { useCallback } from 'react'
import { isTerminalOscLinkRanges } from '../../../src/shared/terminal-osc-link-ranges'
import * as nativeChatTerminalStream from './mobile-native-chat-terminal-stream'
import { subscribeMobileTerminalSafely } from './mobile-terminal-stream-subscribe'
import {
  readTerminalViewportDims,
  runTerminalViewportFitPass
} from './mobile-terminal-viewport-resubscribe'
import { updateTerminalCwdFromStreamEvent } from './mobile-session-route-helpers'
import type { MobileDisplayMode } from './mobile-session-route-types'
import type { MobileSessionTerminalSubscriptionFoundationModel } from './use-mobile-session-terminal-subscription-foundation'

export function useMobileSessionTerminalSubscription(
  scope: MobileSessionTerminalSubscriptionFoundationModel
) {
  const {
    client,
    setTerminalModes,
    terminalCwdRef,
    deviceTokenRef,
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
    terminalFrameHeightRef,
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
    (handle: string) => {
      const diagnostics = terminalDiagnosticsRef.current
      const logSkippedGate = (reason: string) =>
        diagnostics.streamSkipped(handle, reason, handle === activeHandleRef.current)
      if (!client) {
        logSkippedGate('no-client')
        return
      }
      if (terminalUnsubsRef.current.has(handle)) {
        logSkippedGate('already-subscribed')
        return
      }
      if (subscribingHandlesRef.current.has(handle)) {
        logSkippedGate('subscribe-in-flight')
        return
      }
      const covered = nativeChatTerminalStream.isTerminalCoveredByNativeChat(
        showNativeChatRef.current,
        activeHandleRef.current,
        handle
      )
      // Why: a native-chat-covered terminal has no mounted webview, so only gate on the webview when not covered.
      if (!covered) {
        if (!getTerminalRef(handle)) {
          logSkippedGate('no-webview-ref')
          return
        }
        if (!webReadyHandlesRef.current.has(handle)) {
          logSkippedGate('webview-not-ready')
          return
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

      // Why: viewport is embedded in the subscribe params so the server auto-fits before serializing scrollback (no focus→safeFit race).
      const unsub = subscribeMobileTerminalSafely(
        client,
        {
          terminal: handle,
          client: { id: deviceTokenRef.current!, type: 'mobile' as const },
          viewport: nativeChatTerminalStream.mobileNativeChatSubscribeViewport(
            covered,
            viewportRef.current
          ),
          capabilities: nativeChatTerminalStream.mobileNativeChatTerminalCapabilities(covered)
        },
        (result) => {
          if (subscribeSeqRef.current.get(handle) !== seq) {
            return
          }
          const data = result as Record<string, unknown>
          diagnostics.firstStreamEvent(handle, seq, data.type)
          if (data.type === 'end' || data.type === 'error') {
            unsubscribeTerminalRef.current(handle)
            signalTerminalInventoryRecovery()
            return
          }
          if (data.type === 'subscribed') {
            markNativeChatInputLeaseReady(handle)
            return
          }
          // Why: keep the subscription as the input-floor lease but don't mutate covered xterm state; return-to-terminal resubscribes.
          if (
            nativeChatTerminalStream.isTerminalCoveredByNativeChat(
              showNativeChatRef.current,
              activeHandleRef.current,
              handle
            )
          ) {
            return
          }
          // Why: drop `resized` events older than the seen seq (superseded layout); scrollback always resets the mark, else reconnect blanks the terminal.
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
            // Why: absent host dims must not be coerced into a comparable size — 80x24
            // never equals a phone viewport and armed a zero-delay resubscribe loop (STA-3337).
            const cols = hostCols ?? viewportRef.current?.cols ?? 80
            const rows = hostRows ?? viewportRef.current?.rows ?? 24
            const initialData =
              typeof data.serialized === 'string' && data.serialized.length > 0
                ? data.serialized
                : ''
            const oscLinks = isTerminalOscLinkRanges(data.oscLinks) ? data.oscLinks : undefined
            const ref = getTerminalRef(handle)
            // Why: only mark initialized once init() reaches the WebView, else later scrollback is dropped and the terminal stays blank.
            if (!ref) {
              console.log('[fit][session] scrollback DROPPED — no terminal ref', {
                handle: handle.slice(-8),
                cols,
                rows
              })
              return
            }
            ref.init(cols, rows, initialData, false, oscLinks)
            initializedHandlesRef.current.add(handle)
            if (data.displayMode) {
              const displayMode = data.displayMode as MobileDisplayMode
              // Why: same-mode frames must keep the Map identity, or every stream pass re-renders the whole route.
              setTerminalModes((prev) =>
                prev.get(handle) === displayMode ? prev : new Map(prev).set(handle, displayMode)
              )
            }
            // Why: cold-start refit — init()'s fit can run against a transient scrollWidth, so re-fire against a settled DOM.
            scheduleDelayedAction(() => getTerminalRef(handle)?.resetZoom(), 200)
            // Why: first subscribe has no viewport (xterm not loaded yet), so measure after init
            // and resubscribe so the server can phone-fit — bounded per handle so a
            // non-converging host degrades visibly instead of hot-looping (STA-3337).
            runTerminalViewportFitPass({
              handle,
              seq,
              hostCols,
              hostRows,
              budget: viewportResubscribeBudgetRef.current,
              diagnostics,
              viewportRef,
              viewportMeasuredRef,
              subscribeSeqRef,
              initializedHandlesRef,
              terminalUnsubsRef,
              terminalFrameHeightRef,
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
            // Why: missing ref is the likely cause of "blank but input works" — writes dropped after mid-flight unmount or scrollback never landed.
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
            // Server resize: reinit xterm on a full-buffer snapshot (width reflow rewraps scrollback), else just resize geometry.
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
              getTerminalRef(handle)?.init(cols, rows, serialized, true, oscLinks)
            } else {
              getTerminalRef(handle)?.resize(cols, rows)
            }
            if (data.displayMode) {
              const displayMode = data.displayMode as MobileDisplayMode
              // Why: same-mode frames must keep the Map identity, or every stream pass re-renders the whole route.
              setTerminalModes((prev) =>
                prev.get(handle) === displayMode ? prev : new Map(prev).set(handle, displayMode)
              )
            }
            scheduleDelayedAction(() => getTerminalRef(handle)?.resetZoom(), 200)
          }
        },
        () => {
          unsubscribeTerminalRef.current(handle)
          signalTerminalInventoryRecovery()
        }
      )

      if (subscribeSeqRef.current.get(handle) === seq) {
        terminalUnsubsRef.current.set(handle, unsub)
      } else {
        unsub()
      }
      subscribingHandlesRef.current.delete(handle)
    },
    [
      client,
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
