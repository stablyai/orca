import { useMemo } from 'react'
import type { MobileAnimatedInterpolation } from '../platform/animated-handles'
import { useRelayRecoveryStatus } from '../transport/connection/client-context-connection-metrics'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useInitialSessionTerminalAutoCreate } from '../terminal/session/creation/use-initial-session-terminal-autocreate'
import { mobileSessionStatusLabel } from '../transport/connection/mobile-session-connection-copy'
import type { MobileSessionBulkCloseModel } from './tabs/use-mobile-session-bulk-close'
import { useReducedMotionEnabled } from '../platform/accessibility/use-reduced-motion'
import { useDirectionPadAvailable, useShellSideRail } from '../layout/use-shell-side-rail'
import { useCalmConnectionState } from '../transport/connection/calm-connection-state'
import {
  isSessionErrorVerdict,
  sessionConnectionVerdict,
  sessionRetryAvailable,
  sessionStatusDot,
  sessionStatusLine
} from './session-connection-verdict'

// The toast rises this far as it fades in; Reduce Motion keeps the fade alone.
const TOAST_RISE_PX = 8

function sessionPlaceLabel(name: string, branch: string | null, repo: string | null) {
  if (branch && branch !== name) {
    return branch
  }
  return repo && repo !== name ? repo : branch
}

export function useMobileSessionPresentation(scope: MobileSessionBulkCloseModel) {
  const t = useMobileTranslation()
  const {
    created,
    hostId,
    hostName,
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
  const relayRecovery = useRelayRecoveryStatus(hostId)
  const connectionVerdict = sessionConnectionVerdict(
    {
      state: connState,
      reconnectAttempts,
      lastConnectedAt,
      endpoint: hostEndpoint,
      hostName,
      ...relayRecovery
    },
    t
  )
  // Errors, refused pairings included, keep the title block visible beside side-rail tabs.
  const connectionEscalated = isSessionErrorVerdict(connectionVerdict)
  const showConnectionRetry = sessionRetryAvailable(connectionVerdict, forceReconnectHost !== null)

  // Delay reconnect header changes so brief self-healing drops cannot flicker the label.
  const presentedConnState = useCalmConnectionState(connState, lastConnectedAt)
  // A session with nothing to draw says it is offline instead of showing an empty frame.
  const showOfflineState = presentedConnState !== 'connected' && nothingActive
  const statusLine = sessionStatusLine({
    verdict: connectionVerdict,
    presentedConnState,
    pendingPath: relayRecovery.pendingPath,
    retryShown: showConnectionRetry,
    t
  })
  const statusDot = sessionStatusDot({ verdict: connectionVerdict, connState, presentedConnState })
  const terminalSummary =
    statusLine === null
      ? showLoadingState && visibleTabs.length === 0
        ? t('session.presentation.loadingTabs', 'Loading tabs')
        : // The tab count lives in the tab bar, so the header names the branch, or the project when the branch repeats the title.
          (sessionPlaceLabel(scope.worktreeName, scope.worktreeBranch, scope.worktreeRepo) ??
          mobileSessionStatusLabel('connected', t))
      : statusLine.withRetrySuffix
        ? t('session.presentation.tapToRetry', '{{status}} — tap to retry', {
            status: statusLine.label
          })
        : statusLine.label

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
    statusDot,
    terminalSummary,
    dockBottomInset,
    toastRise
  }
}

export type MobileSessionPresentationModel = MobileSessionBulkCloseModel &
  ReturnType<typeof useMobileSessionPresentation>
