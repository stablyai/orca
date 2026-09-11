import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { AgentHibernationGate } from '../components/AgentHibernationGate'
import { AiVaultTabTitleSyncGate } from '../components/AiVaultTabTitleSyncGate'
import RetainedAgentsSyncGate from '../components/dashboard/RetainedAgentsSyncGate'
import { WorkspacePortScanner } from '../components/ports/WorkspacePortScanner'
import { MacosTccPromptNoticeHost } from '../hooks/MacosTccPromptNoticeHost'
import { useAppStore } from '../store'
import { StructuredAgentSessionStatusBridge } from '../components/native-chat/StructuredAgentSessionStatusBridge'

const DashboardPopoutBridge = lazy(() => import('../components/dashboard/DashboardPopoutBridge'))

/**
 * App-level gates that render nothing. Each lives here rather than inside the surface that
 * needs it so its high-churn store subscriptions stay out of the App render tree.
 */
export function AppBackgroundServices(): React.JSX.Element {
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const dashboardPopoutEnabled = useAppStore(
    (s) => s.settings?.experimentalAgentDashboardPopout === true
  )

  return (
    <>
      <WorkspacePortScanner enabled={workspaceSessionReady} />
      {/* Why: plugin language-pack discovery must not re-render the App shell. */}
      <MacosTccPromptNoticeHost />
      {/* Why: leaf-mounted retention sync keeps agent-status subscriptions out of the App render tree. */}
      <RetainedAgentsSyncGate />
      <AiVaultTabTitleSyncGate />
      {dashboardPopoutEnabled ? (
        <Suspense fallback={null}>
          <DashboardPopoutBridge />
        </Suspense>
      ) : null}
      <AgentHibernationGate />
      <StructuredAgentSessionStatusBridge />
    </>
  )
}
