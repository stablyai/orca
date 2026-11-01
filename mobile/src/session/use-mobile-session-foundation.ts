import { useState, useEffect } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams } from 'expo-router'
import { useRouteHandoff } from '../navigation/route-handoff'
import { HOST_DOCK_MIN_WIDTH } from '../storage/preferences'
import { useForceReconnect } from '../transport/host-client-hooks'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import {
  useLastConnectedAt,
  useReconnectAttempt
} from '../transport/client-context-connection-metrics'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { type ActivePanel, canDockSessionPanel } from './session-panel-host'
import { useMobilePrBranchContext } from './use-mobile-pr-branch-context'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { useLiveWorktreeName } from './use-live-worktree-name'
import { useMissingWorktreeBounce } from './use-missing-worktree-bounce'
import { hostRouteWithNotice } from '../host-route-notice'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'

export function useMobileSessionFoundation() {
  const {
    hostId,
    worktreeId,
    name: routeWorktreeName,
    created,
    warning: createdWarning
  } = useLocalSearchParams<{
    hostId: string
    worktreeId: string
    name?: string
    created?: string
    warning?: string
  }>()
  const isFolderWorkspaceRoute = worktreeId.startsWith('folder:')
  const isFloatingWorkspaceRoute = isFloatingWorkspaceWorktreeId(worktreeId)
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const { client, clientId, state: connState } = useWorkspaceClient(hostId)
  const { hostCapabilities } = useHostProtocolGates()
  const reconnectAttempts = useReconnectAttempt(hostId)
  const lastConnectedAt = useLastConnectedAt(hostId)
  const forceReconnectHost = useForceReconnect()
  const {
    name: worktreeName,
    path: worktreePath,
    hostId: worktreeHostId,
    resolution: worktreeResolution
  } = useLiveWorktreeName({
    client,
    connState,
    routeName: routeWorktreeName,
    worktreeId
  })
  useMissingWorktreeBounce({
    hostId,
    worktreeId,
    resolution: worktreeResolution,
    bounce: (id) => router.replace(hostRouteWithNotice(id, 'worktree-missing'))
  })
  const { isWideLayout } = useResponsiveLayout()
  const [activePanel, setActivePanel] = useState<ActivePanel>(null)
  const [sessionContentRowWidth, setSessionContentRowWidth] = useState(0)
  const canDockPanel =
    !isFloatingWorkspaceRoute &&
    canDockSessionPanel({
      isWideLayout,
      availableWidth: sessionContentRowWidth,
      dockWidth: HOST_DOCK_MIN_WIDTH
    })
  // Clear dock selection when rotation makes it too narrow so it cannot survive into push/overlay layout.
  useEffect(() => {
    if (!canDockPanel && activePanel !== null) {
      setActivePanel(null)
    }
  }, [canDockPanel, activePanel])
  // Gate hosted reviews on repo provider without paying for unused branch identity reads.
  const { isGithubRepo: prIsGithubRepo, repoLoaded: prRepoContextLoaded } =
    useMobilePrBranchContext({
      // Synthetic floating workspaces have no repo; a null client prevents the probe.
      client: isFloatingWorkspaceRoute ? null : client,
      connState,
      worktreeId,
      includeBranchIdentity: false
    })
  useEffect(() => {
    if (prRepoContextLoaded && !prIsGithubRepo && activePanel === 'pr') {
      setActivePanel(null)
    }
  }, [activePanel, prRepoContextLoaded, prIsGithubRepo])
  const initialCreateWarning = typeof createdWarning === 'string' ? createdWarning.trim() : ''
  return {
    hostId,
    worktreeId,
    routeWorktreeName,
    created,
    createdWarning,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    router,
    insets,
    client,
    clientId,
    connState,
    hostCapabilities,
    reconnectAttempts,
    lastConnectedAt,
    forceReconnectHost,
    worktreeName,
    worktreePath,
    worktreeHostId,
    worktreeResolution,
    isWideLayout,
    activePanel,
    setActivePanel,
    sessionContentRowWidth,
    setSessionContentRowWidth,
    canDockPanel,
    prIsGithubRepo,
    prRepoContextLoaded,
    initialCreateWarning
  }
}

export type MobileSessionFoundationModel = ReturnType<typeof useMobileSessionFoundation>
