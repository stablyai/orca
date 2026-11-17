import { useMemo } from 'react'
import type { MobileAnimatedInterpolation } from '../platform/animated-handles'
import {
  classifyConnection,
  isConnectionOutage,
  verdictDisplayLabel
} from '../transport/connection/connection-health'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useInitialSessionTerminalAutoCreate } from '../terminal/session/creation/use-initial-session-terminal-autocreate'
import { MOBILE_SESSION_STATUS_LABELS } from '../transport/connection/mobile-session-connection-copy'
import type { MobileSessionBulkCloseModel } from './tabs/use-mobile-session-bulk-close'
import { useReducedMotionEnabled } from '../platform/accessibility/use-reduced-motion'
import { useDirectionPadAvailable, useShellSideRail } from '../layout/use-shell-side-rail'
import { useCalmConnectionState } from '../transport/connection/calm-connection-state'

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
    toastOpacityRef,
    hostEndpoint,
    initialSessionAutoCreateRef,
    handleCreateTerminal,
    visibleTabs,
    forceReconnectHost
  } = scope
  // A strip drawn from cache has no active tab until the host's snapshot lands, so the body shows a state, not an empty frame.
  const nothingActive = scope.activeSessionTab === null && !activeHandle
  const showLoadingState = connState === 'connected' && !terminalsLoaded && nothingActive
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
  // A session with nothing to draw says it is offline instead of showing an empty frame.
  const showOfflineState = presentedConnState !== 'connected' && nothingActive
  const terminalSummary =
    presentedConnState === 'connected'
      ? showLoadingState && visibleTabs.length === 0
        ? t('session.presentation.loadingTabs', 'Loading tabs')
        : // The tab count lives in the tab bar, so the header names the branch instead.
          (scope.worktreeBranch ?? MOBILE_SESSION_STATUS_LABELS.connected)
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
  const reducedMotion = useReducedMotionEnabled()
  const toastRise = useMemo<MobileAnimatedInterpolation | 0>(
    () =>
      reducedMotion === false
        ? toastOpacityRef.current.interpolate({
            inputRange: [0, 1],
            outputRange: [TOAST_RISE_PX, 0]
          })
        : 0,
    [reducedMotion, toastOpacityRef]
  )
  return {
    presentedConnState,
    showLoadingState,
    showEmptyState,
    showOfflineState,
    connectionVerdict,
    showConnectionRetry,
    connectionEscalated,
    terminalSummary,
    dockBottomInset,
    toastRise
  }
}

export type MobileSessionPresentationModel = MobileSessionBulkCloseModel &
  ReturnType<typeof useMobileSessionPresentation>
