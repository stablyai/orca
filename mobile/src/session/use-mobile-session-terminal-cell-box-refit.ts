import { useCallback } from 'react'
import * as nativeChatTerminalStream from './mobile-native-chat-terminal-stream'
import { runTerminalViewportFitPass } from './mobile-terminal-viewport-resubscribe'
import type { MobileSessionTerminalSubscriptionFoundationModel } from './use-mobile-session-terminal-subscription-foundation'

/**
 * The document laid out a different cell box than the fit assumed (a wrong probe guess, a renderer
 * swap). Re-fit the frame with it; if the grid should change, the bounded fit pass tells the host.
 * `grid` is xterm's current size, which is the host's.
 */
export function useTerminalCellBoxRefit(
  scope: MobileSessionTerminalSubscriptionFoundationModel,
  subscribeToTerminal: (handle: string) => void
) {
  const {
    viewportRef,
    viewportMeasuredRef,
    terminalUnsubsRef,
    initializedHandlesRef,
    terminalDiagnosticsRef,
    viewportResubscribeBudgetRef,
    activeHandleRef,
    subscribeSeqRef,
    terminalFrameHeightRef,
    showNativeChatRef,
    scheduleDelayedAction,
    showToast,
    getTerminalRef,
    unsubscribeTerminal
  } = scope
  return useCallback(
    (handle: string, grid: { cols: number; rows: number }) => {
      if (
        !initializedHandlesRef.current.has(handle) ||
        !terminalUnsubsRef.current.has(handle) ||
        nativeChatTerminalStream.isTerminalCoveredByNativeChat(
          showNativeChatRef.current,
          activeHandleRef.current,
          handle
        )
      ) {
        return
      }
      const sentViewport = viewportRef.current
      const dims = getTerminalRef(handle)?.fitDimensions(
        terminalFrameHeightRef.current || undefined
      )
      if (!dims || (sentViewport?.cols === dims.cols && sentViewport.rows === dims.rows)) {
        return
      }
      viewportRef.current = dims
      viewportMeasuredRef.current = true
      runTerminalViewportFitPass({
        handle,
        seq: subscribeSeqRef.current.get(handle) ?? 0,
        hostCols: grid.cols,
        hostRows: grid.rows,
        sentViewport,
        budget: viewportResubscribeBudgetRef.current,
        diagnostics: terminalDiagnosticsRef.current,
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
    },
    [getTerminalRef, scheduleDelayedAction, showToast, subscribeToTerminal, unsubscribeTerminal]
  )
}
