import { useCallback } from 'react'
import * as nativeChatTerminalStream from './mobile-native-chat-terminal-stream'
import type { MobileSessionTerminalSubscriptionFoundationModel } from './use-mobile-session-terminal-subscription-foundation'
import { presentHostSessionTerminalStreamEvent } from './host-session-terminal-stream-presentation'

export function useMobileSessionTerminalSubscription(
  scope: MobileSessionTerminalSubscriptionFoundationModel
) {
  const {
    clientId,
    hostClientIdentityReady,
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
    terminalFrameHeightRef,
    scheduleDelayedAction,
    showToast,
    markNativeChatInputLeaseReady,
    showNativeChatRef,
    getTerminalRef,
    unsubscribeTerminalRef,
    signalTerminalInventoryRecovery,
    sessionTerminalOperations,
    worktreeId,
    deliverPendingQuickCommandInput
  } = scope
  const subscribeToTerminal = useCallback(
    (handle: string) => {
      const diagnostics = terminalDiagnosticsRef.current
      const logSkippedGate = (reason: string) =>
        diagnostics.streamSkipped(handle, reason, handle === activeHandleRef.current)
      if (!sessionTerminalOperations) {
        logSkippedGate('no-terminal-operations')
        return
      }
      if (!hostClientIdentityReady) {
        logSkippedGate('no-client-identity')
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
      const unsub = sessionTerminalOperations.subscribe(
        {
          workspaceId: worktreeId,
          terminalId: handle,
          clientId,
          viewport: nativeChatTerminalStream.mobileNativeChatSubscribeViewport(
            covered,
            viewportRef.current
          ),
          visible: !covered,
          capabilities: nativeChatTerminalStream.mobileNativeChatTerminalCapabilities(covered)
        },
        (result) => {
          presentHostSessionTerminalStreamEvent({
            event: result,
            handle,
            subscribeSequence: seq,
            isCovered: () =>
              nativeChatTerminalStream.isTerminalCoveredByNativeChat(
                showNativeChatRef.current,
                activeHandleRef.current,
                handle
              ),
            unsubscribe: unsubscribeTerminalRef.current,
            markInputLeaseReady: markNativeChatInputLeaseReady,
            signalTerminalInventoryRecovery,
            layoutSequences: layoutSeqRef.current,
            terminalCwds: terminalCwdRef.current,
            getTerminalRef,
            operations: sessionTerminalOperations,
            setDisplayMode: (terminalId, mode) =>
              // Why: same-mode frames must keep the Map identity, or every stream pass re-renders the whole route.
              setTerminalModes((previous) =>
                previous.get(terminalId) === mode
                  ? previous
                  : new Map(previous).set(terminalId, mode)
              ),
            diagnostics,
            scheduleDelayedAction,
            viewportRef,
            viewportMeasuredRef,
            terminalFrameHeightRef,
            subscribeSeqRef,
            initializedHandlesRef,
            terminalUnsubsRef,
            viewportResubscribeBudget: viewportResubscribeBudgetRef.current,
            showToast,
            subscribe: subscribeToTerminal
          })
          if (result.type === 'subscribed') {
            void deliverPendingQuickCommandInput(handle)
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
      clientId,
      hostClientIdentityReady,
      getTerminalRef,
      deliverPendingQuickCommandInput,
      markNativeChatInputLeaseReady,
      scheduleDelayedAction,
      sessionTerminalOperations,
      showToast,
      signalTerminalInventoryRecovery,
      worktreeId
    ]
  )
  return {
    subscribeToTerminal
  }
}

export type MobileSessionTerminalSubscriptionModel =
  MobileSessionTerminalSubscriptionFoundationModel &
    ReturnType<typeof useMobileSessionTerminalSubscription>
