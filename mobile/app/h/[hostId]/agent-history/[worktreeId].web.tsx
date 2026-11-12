import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import { useLocalSearchParams } from 'expo-router'
import { MobileAgentSessionHistoryPanel } from '../../../../src/agent-history/MobileAgentSessionHistoryPanel'
import { firstParam } from '../../../../src/navigation/route-param-reader'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default withWorkspaceRoute(function MobileAgentSessionHistoryScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    origin?: string | string[]
  }>()
  return (
    <MobileAgentSessionHistoryPanel
      hostId={firstParam(params.hostId)}
      worktreeId={firstParam(params.worktreeId)}
      name={firstParam(params.name)}
      origin={firstParam(params.origin)}
    />
  )
})
