import {
  classifyConnection,
  isConnectionOutage,
  verdictDisplayLabel
} from '../transport/connection-health'
import { computeActiveTerminalKeyboardLift } from '../terminal/terminal-keyboard-avoidance-lift'
import { useInitialSessionTerminalAutoCreate } from './use-initial-session-terminal-autocreate'
import { MOBILE_SESSION_STATUS_LABELS } from './mobile-session-route-helpers'
import type { MobileSessionBulkCloseModel } from './use-mobile-session-bulk-close'
import { hostOs } from '../platform/host-os'
import { useCalmConnectionState } from '../transport/calm-connection-state'

export function useMobileSessionPresentation(scope: MobileSessionBulkCloseModel) {
  const {
    created,
    worktreeId,
    router,
    insets,
    connState,
    client,
    reconnectAttempts,
    lastConnectedAt,
    terminalsLoaded,
    activeHandle,
    creating,
    creatingBrowser,
    creatingMarkdown,
    keyboardHeight,
    terminalKeyboardMetrics,
    toastOpacityRef,
    hostEndpoint,
    initialSessionAutoCreateRef,
    terminalFrameRef,
    handleCreateTerminal,
    visibleTabs,
    forceReconnectHost
  } = scope
  const showLoadingState = connState === 'connected' && !terminalsLoaded && visibleTabs.length === 0
  const showEmptyState =
    connState === 'connected' && terminalsLoaded && visibleTabs.length === 0 && !activeHandle

  useInitialSessionTerminalAutoCreate({
    client,
    newlyCreatedWorkspace: created === '1',
    connState,
    terminalsLoaded,
    visibleTabCount: visibleTabs.length,
    activeHandle,
    createInFlight: creating || creatingBrowser || creatingMarkdown,
    stateRef: initialSessionAutoCreateRef,
    worktreeId,
    consumeCreationRoute: () => router.setParams({ created: undefined }),
    createTerminal: () => void handleCreateTerminal()
  })

  // Offer explicit retry after reconnect backoff reaches 90s so recovery need not wait for the next attempt.
  const connectionVerdict = classifyConnection({
    state: connState,
    reconnectAttempts,
    lastConnectedAt,
    endpoint: hostEndpoint
  })
  const connectionEscalated = isConnectionOutage(connectionVerdict)
  const showConnectionRetry = connectionEscalated && forceReconnectHost !== null

  // Delay reconnect header changes so brief self-healing drops cannot flicker the label.
  const presentedConnState = useCalmConnectionState(connState, lastConnectedAt)
  const terminalSummary =
    presentedConnState === 'connected'
      ? showLoadingState
        ? 'Loading tabs'
        : visibleTabs.length === 1
          ? '1 tab'
          : `${visibleTabs.length} tabs`
      : showConnectionRetry
        ? `${verdictDisplayLabel(connectionVerdict)} — tap to retry`
        : connectionEscalated
          ? verdictDisplayLabel(connectionVerdict)
          : MOBILE_SESSION_STATUS_LABELS[presentedConnState]

  // Why: iOS keyboard height includes the home-indicator inset; Android IME height does not.
  const keyboardLift =
    keyboardHeight > 0
      ? hostOs() === 'ios'
        ? Math.max(0, keyboardHeight - insets.bottom)
        : keyboardHeight
      : 0
  const activeTerminalKeyboardLift = computeActiveTerminalKeyboardLift({
    keyboardLift,
    metrics: activeHandle ? terminalKeyboardMetrics.get(activeHandle) : undefined,
    terminalFrameHeight: terminalFrameRef.current?.height ?? 0
  })
  const toastAnimatedStyle = {
    opacity: toastOpacityRef.current,
    transform: [{ translateY: -keyboardLift }]
  }
  return {
    presentedConnState,
    showLoadingState,
    showEmptyState,
    connectionVerdict,
    showConnectionRetry,
    terminalSummary,
    keyboardLift,
    activeTerminalKeyboardLift,
    toastAnimatedStyle
  }
}

export type MobileSessionPresentationModel = MobileSessionBulkCloseModel &
  ReturnType<typeof useMobileSessionPresentation>
