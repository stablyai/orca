import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { AgentHibernationGate } from '../components/AgentHibernationGate'
import { AiVaultTabTitleSyncGate } from '../components/AiVaultTabTitleSyncGate'
import RetainedAgentsSyncGate from '../components/dashboard/retention/RetainedAgentsSyncGate'
import { WorkspacePortScanner } from '../components/ports/WorkspacePortScanner'
import { SavedHostScopeWidenGate } from '../components/sidebar/worktree-list/listing/SavedHostScopeWidenGate'
import { MacosTccPromptNoticeHost } from '../hooks/MacosTccPromptNoticeHost'
import { RemoteHostBrowserControlNoticeHost } from '../components/browser-pane/remote-host-control/RemoteHostBrowserControlNoticeHost'
import { useAppStore } from '../store/index'
import { ActiveWorkspaceSyncGate } from './ActiveWorkspaceSyncGate'
import { StructuredAgentSessionAttentionBridge } from '../components/native-chat/session/attention/StructuredAgentSessionAttentionBridge'
import { StructuredAgentSessionStatusBridge } from '../components/native-chat/session/status/StructuredAgentSessionStatusBridge'
import { NativeChatVisualGuestThemePublisher } from '../components/native-chat/media/visuals/NativeChatVisualGuestThemePublisher'
import { usePairedMobileDevices } from '../components/mobile/paired-mobile-devices'

const DashboardPopoutBridge = lazy(
  () => import('../components/dashboard/popout-bridge/DashboardPopoutBridge')
)
const AgentListVerdictPublisher = lazy(
  () => import('../components/activity/agent-list-verdict-publisher')
)

/** Isolate high-churn subscriptions from App rendering; services outlive their consuming surfaces. */
export function AppBackgroundServices(): React.JSX.Element {
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const dashboardPopoutEnabled = useAppStore(
    (s) => s.settings?.experimentalAgentDashboardPopout === true
  )
  const canPublishAgentList = Boolean(window.api.agentStatus?.publishListVerdicts)
  // The list builds on every agent update, so only a desktop with a paired phone pays for it.
  const { hasPairedDevice } = usePairedMobileDevices({ enabled: canPublishAgentList })

  return (
    <>
      <NativeChatVisualGuestThemePublisher />
      <WorkspacePortScanner enabled={workspaceSessionReady} />
      <ActiveWorkspaceSyncGate />
      {/* Keep permission notices available across app surfaces. */}
      <MacosTccPromptNoticeHost />
      <RemoteHostBrowserControlNoticeHost />
      {/* Keep agent-status retention subscriptions out of the App render tree. */}
      <RetainedAgentsSyncGate />
      <AiVaultTabTitleSyncGate />
      <SavedHostScopeWidenGate />
      {dashboardPopoutEnabled ? (
        <Suspense fallback={null}>
          <DashboardPopoutBridge />
        </Suspense>
      ) : null}
      <AgentHibernationGate />
      {/* Paired phones list agents with the desktop Agents list's verdicts; web clients have no host to tell. */}
      {canPublishAgentList && hasPairedDevice ? (
        <Suspense fallback={null}>
          <AgentListVerdictPublisher />
        </Suspense>
      ) : null}
      <StructuredAgentSessionStatusBridge />
      {/* Background chats have no mounted pane but still need completion attention. */}
      <StructuredAgentSessionAttentionBridge />
    </>
  )
}
