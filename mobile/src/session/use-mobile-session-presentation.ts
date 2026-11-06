import { useMemo } from 'react'
import {
  classifyConnection,
  isConnectionOutage,
  verdictDisplayLabel
} from '../transport/connection-health'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { computeActiveTerminalKeyboardLift } from '../terminal/terminal-keyboard-avoidance-lift'
import { useInitialSessionTerminalAutoCreate } from './use-initial-session-terminal-autocreate'
import { MOBILE_SESSION_STATUS_LABELS } from './mobile-session-route-helpers'
import type { MobileSessionBulkCloseModel } from './use-mobile-session-bulk-close'
import { hostOs } from '../platform/host-os'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { useDirectionPadAvailable, useShellSideRail } from '../layout/use-shell-side-rail'
import { useCalmConnectionState } from '../transport/calm-connection-state'

// The toast rises this far as it fades in; Reduce Motion keeps the fade alone.
const TOAST_RISE_PX = 8

export function useMobileSessionPresentation(scope: MobileSessionBulkCloseModel) {
  const t = useMobileTranslation()
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
    getTerminalPaneViewport,
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
  // A cold session with nothing to draw says it is offline instead of showing an empty frame.
  const showOfflineState = presentedConnState !== 'connected' && visibleTabs.length === 0
  const terminalSummary =
    presentedConnState === 'connected'
      ? showLoadingState
        ? t('session.presentation.loadingTabs', 'Loading tabs')
        : visibleTabs.length === 1
          ? t('session.presentation.oneTab', '1 tab')
          : t('session.presentation.tabCount', '{{tabCount}} tabs', {
              tabCount: visibleTabs.length
            })
      : showConnectionRetry
        ? t('session.presentation.tapToRetry', '{{status}} — tap to retry', {
            status: verdictDisplayLabel(connectionVerdict)
          })
        : connectionEscalated
          ? verdictDisplayLabel(connectionVerdict)
          : MOBILE_SESSION_STATUS_LABELS[presentedConnState]

  const [sideRail, padAvailable] = [useShellSideRail(), useDirectionPadAvailable()]
  const dockShown =
    !scope.showNativeChat &&
    !scope.activeMarkdownTab &&
    !scope.activeFileTab &&
    !scope.activeBrowserTab
  const dockBottomInset = dockShown && (sideRail || padAvailable) ? 0 : insets.bottom
  // Subtract only the space actually reserved below the input dock.
  const keyboardLift =
    keyboardHeight > 0
      ? hostOs() === 'ios'
        ? Math.max(0, keyboardHeight - dockBottomInset)
        : keyboardHeight
      : 0
  const activeTerminalKeyboardLift = computeActiveTerminalKeyboardLift({
    keyboardLift,
    metrics: activeHandle ? terminalKeyboardMetrics.get(activeHandle) : undefined,
    terminalFrameHeight:
      (activeHandle
        ? getTerminalPaneViewport?.(activeHandle).terminalFrameRef.current?.height
        : null) ??
      terminalFrameRef.current?.height ??
      0
  })
  const reducedMotion = useReducedMotionEnabled()
  const toastRise = useMemo(
    () =>
      reducedMotion === false
        ? toastOpacityRef.current.interpolate({
            inputRange: [0, 1],
            outputRange: [TOAST_RISE_PX, 0]
          })
        : 0,
    [reducedMotion, toastOpacityRef]
  )
  const toastAnimatedStyle = {
    opacity: toastOpacityRef.current,
    transform: [{ translateY: -keyboardLift }, { translateY: toastRise }]
  }
  return {
    presentedConnState,
    showLoadingState,
    showEmptyState,
    showOfflineState,
    connectionVerdict,
    showConnectionRetry,
    connectionEscalated,
    terminalSummary,
    keyboardLift,
    activeTerminalKeyboardLift,
    toastAnimatedStyle
  }
}

export type MobileSessionPresentationModel = MobileSessionBulkCloseModel &
  ReturnType<typeof useMobileSessionPresentation>
