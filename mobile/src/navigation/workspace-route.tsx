import type { ReactNode } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { firstParam } from './route-param-reader'
import { WorkspaceExecutionHostContext } from './workspace-execution-host'
import {
  HostStatusGatesContext,
  useOptionalHostProtocolGates
} from '../components/host-protocol-gates-context'
import { PageRouteUnavailableScreen } from '../mobile-web-shell/PageRouteUnavailableScreen'
import { useHostClient } from '../transport/host-client-hooks'
import { WorkspaceServerContext } from '../transport/use-workspace-client'
import { useWorkspaceServer } from '../transport/workspace-server'

const NO_CAPABILITIES: readonly string[] = []
const UNREACHABLE_SERVER_MESSAGE =
  "Your phone can't reach this workspace's server through this desktop."

// Route calls, pushes and feature gates through executionHost; absent means the paired desktop. Unreachable servers get an explicit refusal after desktop status settles.
export function WorkspaceRoute({ children }: { children: ReactNode }) {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    executionHost?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const executionHost = normalizeExecutionHostId(firstParam(params.executionHost)) ?? undefined
  const { client, state } = useHostClient(hostId)
  const desktopGates = useOptionalHostProtocolGates()
  const { routeHost, server } = useWorkspaceServer({
    client,
    connState: state,
    desktopCapabilities: desktopGates?.hostCapabilities ?? NO_CAPABILITIES,
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
  return server ? (
    <WorkspaceServerContext.Provider value={server}>
      <HostStatusGatesContext.Provider value={server.gates}>
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
