import { useContext, type ReactNode } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import { firstParam } from './route-param-reader'
import { WorkspaceExecutionHostContext } from './workspace-execution-host'
import {
  HostStatusGatesContext,
  useOptionalHostProtocolGates
} from '../components/host-protocol-gates-context'
import { PageRouteUnavailableScreen } from '../mobile-web-shell/PageRouteUnavailableScreen'
import { useHostClient } from '../transport/connection/host-client-hooks'
import { WorkspaceServerContext } from '../worktree/workspace-server-context'
import { useWorkspaceServer } from '../worktree/workspace-server'

const NO_CAPABILITIES: readonly string[] = []
const UNREACHABLE_SERVER_MESSAGE =
  "Your phone can't reach this workspace's server through this desktop."

// Route calls, pushes and feature gates through executionHost; absent means the paired desktop. Unreachable servers get an explicit refusal after desktop status settles.
export function WorkspaceRoute({ children }: { children: ReactNode }) {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    executionHost?: string | string[]
  }>()
  return (
    <WorkspaceExecutionScope
      hostId={firstParam(params.hostId)}
      executionHost={normalizeExecutionHostId(firstParam(params.executionHost)) ?? undefined}
    >
      {children}
    </WorkspaceExecutionScope>
  )
}

/** A route's execution scope for one workspace; screens that show another workspace in place nest their own. */
export function WorkspaceExecutionScope({
  hostId,
  executionHost,
  children
}: {
  hostId: string
  executionHost: ExecutionHostId | undefined
  children: ReactNode
}) {
  const { client, state } = useHostClient(hostId)
  const outerServer = useContext(WorkspaceServerContext)
  const contextGates = useOptionalHostProtocolGates()
  // Nested in a server's scope, the gates in context are that server's, not the desktop's.
  const desktopGates = outerServer ? (outerServer.desktopGates ?? null) : contextGates
  const { routeHost, server } = useWorkspaceServer({
    client,
    connState: state,
    desktopCapabilities: desktopGates?.hostCapabilities ?? NO_CAPABILITIES,
    desktopGates,
    executionHost
  })
  // Settled desktop status cannot become reachable by keeping this spinner open.
  if (state === 'connected' && desktopGates && !desktopGates.statusPending && routeHost === null) {
    return <PageRouteUnavailableScreen hostId={hostId} message={UNREACHABLE_SERVER_MESSAGE} />
  }
  const screens = (
    <WorkspaceExecutionHostContext.Provider value={executionHost}>
      {children}
    </WorkspaceExecutionHostContext.Provider>
  )
  if (server) {
    return (
      <WorkspaceServerContext.Provider value={server}>
        <HostStatusGatesContext.Provider value={server.gates}>
          {screens}
        </HostStatusGatesContext.Provider>
      </WorkspaceServerContext.Provider>
    )
  }
  // A desktop workspace shown inside a server's scope goes back to desktop routing and gates.
  return outerServer ? (
    <WorkspaceServerContext.Provider value={undefined}>
      <HostStatusGatesContext.Provider value={desktopGates}>
        {screens}
      </HostStatusGatesContext.Provider>
    </WorkspaceServerContext.Provider>
  ) : (
    screens
  )
}

export function withWorkspaceRoute(Screen: () => ReactNode): () => ReactNode {
  return function WorkspaceRouteScreen() {
    return (
      <WorkspaceRoute>
        <Screen />
      </WorkspaceRoute>
    )
  }
}
