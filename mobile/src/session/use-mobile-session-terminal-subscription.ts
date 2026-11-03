import { useCallback } from 'react'
import * as nativeChatTerminalStream from './native-chat/mobile-native-chat-terminal-stream'
import {
  createMobileTerminalStreamLifetime,
  subscribeMobileTerminalSafely
} from './mobile-terminal-stream-subscribe'
import { mobileTerminalSnapshotByteBudget } from './terminal-snapshot-byte-budget'
import { createMobileTerminalStreamEventListener } from './mobile-terminal-stream-event-application'
import type { MobileSessionTerminalSubscriptionFoundationModel } from './use-mobile-session-terminal-subscription-foundation'

const snapshotByteBudget = mobileTerminalSnapshotByteBudget()

export function useMobileSessionTerminalSubscription(
  scope: MobileSessionTerminalSubscriptionFoundationModel
) {
  const {
    client,
    clientId,
    getTerminalPaneViewport,
    terminalUnsubsRef,
    subscribingHandlesRef,
    leaseOnlyHandlesRef,
    terminalDiagnosticsRef,
    webReadyHandlesRef,
    activeHandleRef,
    subscribeSeqRef,
    scheduleDelayedAction,
    markNativeChatInputLeaseReady,
    showNativeChatRef,
    getTerminalRef,
    unsubscribeTerminalRef,
    signalTerminalInventoryRecovery
  } = scope
  const subscribeToTerminal = useCallback(
    (handle: string): boolean => {
      const { viewportRef, viewportMeasuredRef, terminalFrameRef } =
        getTerminalPaneViewport?.(handle) ?? scope
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
        createMobileTerminalStreamEventListener({
          scope,
          handle,
          seq,
          lifetime,
          sentViewport,
          subscribeToTerminal
        }),
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
