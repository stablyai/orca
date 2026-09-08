import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { HOST_DOCK_MIN_WIDTH } from '../storage/preferences'
import { useHostClient, useForceReconnect } from '../transport/client-context'
import { useMobileWebRouteParams } from '../mobile-web/use-mobile-web-route-params'
import {
  useLastConnectedAt,
  useRelayRecoveryStatus,
  useReconnectAttempt
} from '../transport/client-context-connection-metrics'
import type { ConnectionState } from '../transport/types'
import { defaultHostSessionTabOperations } from './default-host-session-tab-operations'
import type { HostSessionTabOperations } from './host-session-tab-operations'
import { defaultHostSessionQuickCommandOperations } from './default-host-session-quick-command-operations'
import type { HostSessionQuickCommandOperations } from './host-session-quick-command-operations'
import { defaultHostSessionTerminalOperations } from './default-host-session-terminal-operations'
import type { HostSessionTerminalOperations } from './host-session-terminal-operations'
import { defaultHostSessionTerminalFileOperations } from './default-host-session-terminal-file-operations'
import type { HostSessionTerminalFileOperations } from './host-session-terminal-file-operations'
import { defaultHostSessionFileOperations } from './default-host-session-file-operations'
import type { HostSessionFileOperations } from './host-session-file-operations'
import { defaultHostSessionMarkdownOperations } from './default-host-session-markdown-operations'
import type { HostSessionMarkdownOperations } from './host-session-markdown-operations'
import { defaultHostSessionDeviceOperations } from './default-host-session-device-operations'
import type { HostSessionDeviceOperations } from './host-session-device-operations'
import type { HostSessionDictationOperations } from './host-session-dictation-operations'
import { defaultHostSessionBrowserOperations } from './default-host-session-browser-operations'
import type { HostSessionBrowserOperations } from './host-session-browser-operations'
import { defaultHostSessionNativeChatOperations } from './default-host-session-native-chat-operations'
import type { HostSessionNativeChatOperations } from './host-session-native-chat-operations'
import { defaultHostSessionChatDraftOperations } from './default-host-session-chat-draft-operations'
import type { HostSessionChatDraftOperations } from './host-session-chat-draft-operations'
import { defaultHostSessionChatPendingDeliveryOperations } from './default-host-session-chat-pending-delivery-operations'
import type { HostSessionChatPendingDeliveryOperations } from './host-session-chat-pending-delivery-operations'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { type ActivePanel, canDockSessionPanel } from './session-panel-host'
import { useMobilePrBranchContext } from './use-mobile-pr-branch-context'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { useLiveWorktreeName } from './use-live-worktree-name'
import { useMissingWorktreeBounce } from './use-missing-worktree-bounce'
import { hostRouteWithNotice } from '../host-route-notice'

export type MobileSessionScreenProps = {
  sessionTabOperations?: HostSessionTabOperations
  sessionQuickCommandOperations?: HostSessionQuickCommandOperations
  sessionTerminalOperations?: HostSessionTerminalOperations
  sessionTerminalFileOperations?: HostSessionTerminalFileOperations
  sessionFileOperations?: HostSessionFileOperations
  sessionMarkdownOperations?: HostSessionMarkdownOperations
  sessionDeviceOperations?: HostSessionDeviceOperations
  sessionDictationOperations?: HostSessionDictationOperations
  sessionBrowserOperations?: HostSessionBrowserOperations
  sessionNativeChatOperations?: HostSessionNativeChatOperations
  sessionChatDraftOperations?: HostSessionChatDraftOperations
  sessionChatPendingDeliveryOperations?: HostSessionChatPendingDeliveryOperations
  connectionState?: ConnectionState
  nativeHostBinding?: boolean
  reconnect?: () => Promise<void>
  reconnectAttempts?: number
  lastConnectedAt?: number | null
}

export function useMobileSessionFoundation({
  sessionTabOperations: sessionTabOperationsProp,
  sessionQuickCommandOperations: sessionQuickCommandOperationsProp,
  sessionTerminalOperations: sessionTerminalOperationsProp,
  sessionTerminalFileOperations: sessionTerminalFileOperationsProp,
  sessionFileOperations: sessionFileOperationsProp,
  sessionMarkdownOperations: sessionMarkdownOperationsProp,
  sessionDeviceOperations: sessionDeviceOperationsProp,
  sessionDictationOperations,
  sessionBrowserOperations: sessionBrowserOperationsProp,
  sessionNativeChatOperations: sessionNativeChatOperationsProp,
  sessionChatDraftOperations: sessionChatDraftOperationsProp,
  sessionChatPendingDeliveryOperations: sessionChatPendingDeliveryOperationsProp,
  connectionState: connectionStateProp,
  nativeHostBinding = true,
  reconnect: reconnectProp,
  reconnectAttempts: reconnectAttemptsProp,
  lastConnectedAt: lastConnectedAtProp
}: MobileSessionScreenProps = {}) {
  const {
    hostId,
    worktreeId,
    name: routeWorktreeName,
    created,
    warning: createdWarning
  } = useMobileWebRouteParams<{
    hostId: string
    worktreeId: string
    name?: string
    created?: string
    warning?: string
  }>()
  const isFolderWorkspaceRoute = worktreeId.startsWith('folder:') // Synthetic ids have no repo scope.
  // Why: the floating sentinel has no repo/worktree, so repo-backed surfaces hide.
  const isFloatingWorkspaceRoute = isFloatingWorkspaceWorktreeId(worktreeId)
  const router = useRouter()
  const insets = useSafeAreaInsets()
  // Why: shared client per host owned by RpcClientProvider (docs/mobile-shared-client-per-host.md).
  const nativeHost = useHostClient(nativeHostBinding ? hostId : undefined)
  const client = nativeHost.client
  // Why: the shared client owns authenticated identity (#16239); the hosted page has no native
  // client, the shell signs its bridge traffic, so identity is ready there by construction.
  const clientId = nativeHostBinding ? nativeHost.clientId : null
  const hostClientIdentityReady = !nativeHostBinding || clientId !== null
  const connState = connectionStateProp ?? nativeHost.state
  const sessionTabOperations = useMemo(
    () => sessionTabOperationsProp ?? (client ? defaultHostSessionTabOperations(client) : null),
    [client, sessionTabOperationsProp]
  )
  const sessionQuickCommandOperations = useMemo(
    () =>
      sessionQuickCommandOperationsProp ??
      (client ? defaultHostSessionQuickCommandOperations(client) : null),
    [client, sessionQuickCommandOperationsProp]
  )
  const sessionTerminalOperations = useMemo(
    () =>
      sessionTerminalOperationsProp ??
      (client ? defaultHostSessionTerminalOperations(client) : null),
    [client, sessionTerminalOperationsProp]
  )
  const sessionTerminalFileOperations = useMemo(
    () =>
      sessionTerminalFileOperationsProp ??
      (client ? defaultHostSessionTerminalFileOperations(client) : null),
    [client, sessionTerminalFileOperationsProp]
  )
  const sessionFileOperations = useMemo(
    () => sessionFileOperationsProp ?? (client ? defaultHostSessionFileOperations(client) : null),
    [client, sessionFileOperationsProp]
  )
  const sessionMarkdownOperations = useMemo(
    () =>
      sessionMarkdownOperationsProp ??
      (client ? defaultHostSessionMarkdownOperations(client, hostId) : null),
    [client, hostId, sessionMarkdownOperationsProp]
  )
  const sessionDeviceOperations = useMemo(
    () => sessionDeviceOperationsProp ?? defaultHostSessionDeviceOperations(),
    [sessionDeviceOperationsProp]
  )
  const sessionBrowserOperations = useMemo(
    () =>
      sessionBrowserOperationsProp ?? (client ? defaultHostSessionBrowserOperations(client) : null),
    [client, sessionBrowserOperationsProp]
  )
  const sessionNativeChatOperations = useMemo(
    () =>
      sessionNativeChatOperationsProp ??
      (client ? defaultHostSessionNativeChatOperations(client) : null),
    [client, sessionNativeChatOperationsProp]
  )
  const sessionChatDraftOperations = useMemo(
    () => sessionChatDraftOperationsProp ?? defaultHostSessionChatDraftOperations(hostId),
    [hostId, sessionChatDraftOperationsProp]
  )
  const sessionChatPendingDeliveryOperations = useMemo(
    () =>
      sessionChatPendingDeliveryOperationsProp ??
      defaultHostSessionChatPendingDeliveryOperations(hostId),
    [hostId, sessionChatPendingDeliveryOperationsProp]
  )
  const triggerSelection = useCallback(
    () => sessionDeviceOperations?.hapticFeedback('selection'),
    [sessionDeviceOperations]
  )
  const triggerSuccess = useCallback(
    () => sessionDeviceOperations?.hapticFeedback('success'),
    [sessionDeviceOperations]
  )
  const triggerError = useCallback(
    () => sessionDeviceOperations?.hapticFeedback('error'),
    [sessionDeviceOperations]
  )
  const triggerMediumImpact = useCallback(
    () => sessionDeviceOperations?.hapticFeedback('medium-impact'),
    [sessionDeviceOperations]
  )
  const copyTextToDevice = useCallback(
    async (text: string) => {
      const result = await sessionDeviceOperations?.copyText(text)
      if (!result) {
        throw new Error('Clipboard unavailable')
      }
      return result
    },
    [sessionDeviceOperations]
  )
  const nativeReconnectAttempts = useReconnectAttempt(hostId)
  const nativeLastConnectedAt = useLastConnectedAt(hostId)
  const reconnectAttempts = reconnectAttemptsProp ?? nativeReconnectAttempts
  const lastConnectedAt = lastConnectedAtProp ?? nativeLastConnectedAt
  const relayRecovery = useRelayRecoveryStatus(hostId)
  const forceReconnectHost = useForceReconnect()
  const { name: worktreeName, resolution: worktreeResolution } = useLiveWorktreeName({
    client,
    connState,
    routeName: routeWorktreeName,
    worktreeId
  })
  // Why: a workspace deleted on the desktop leaves every RPC on this route failing forever.
  useMissingWorktreeBounce({
    hostId,
    worktreeId,
    resolution: worktreeResolution,
    bounce: (id) => router.replace(hostRouteWithNotice(id, 'worktree-missing'))
  })
  // Master-detail state: wide layouts dock a tapped panel beside the session; narrow keeps it null and pushes full-screen routes.
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
  // Why: if rotation/split-screen makes the docked row too narrow, clear activePanel so it doesn't survive into overlay/push mode.
  useEffect(() => {
    if (!canDockPanel && activePanel !== null) {
      setActivePanel(null)
    }
  }, [canDockPanel, activePanel])
  // GitHub remote probe gates the PR dock icon so non-GitHub providers can't open the hosted-review surface; skip the unused identity RPCs.
  const { isGithubRepo: prIsGithubRepo, repoLoaded: prRepoContextLoaded } =
    useMobilePrBranchContext({
      // Why: a null client parks the hook in its not-ready state — the floating
      // sentinel has no repo to probe.
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
    hostClientIdentityReady,
    connState,
    reconnectAttempts,
    lastConnectedAt,
    relayRecovery,
    reconnectProp,
    forceReconnectHost,
    sessionTabOperations,
    sessionQuickCommandOperations,
    sessionTerminalOperations,
    sessionTerminalOperationsProp,
    sessionTerminalFileOperations,
    sessionFileOperations,
    sessionMarkdownOperations,
    sessionDeviceOperations,
    sessionDictationOperations,
    sessionBrowserOperations,
    sessionNativeChatOperations,
    sessionChatDraftOperations,
    sessionChatPendingDeliveryOperations,
    triggerSelection,
    triggerSuccess,
    triggerError,
    triggerMediumImpact,
    copyTextToDevice,
    worktreeName,
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
