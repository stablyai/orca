import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import {
  useWorkspaceExecutionHost,
  workspaceRouteParams
} from '../../../../src/navigation/workspace-execution-host'
import { useLocalSearchParams } from 'expo-router'
import { MobileWebShellScreen } from '../../../../src/mobile-web-shell/MobileWebShellScreen'
import { shellScreenRoute } from '../../../../src/mobile-web-shell/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { firstParam } from '../../../../src/navigation/route-param-reader'

// Encode both dynamic segments to keep decoded ids containing /, ?, # or whitespace within one segment.
// Ask shellScreenRoute schema too: encoding cannot make dot/dot-dot ids valid.
export default withWorkspaceRoute(function MobileAgentSessionHistoryScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    origin?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const name = firstParam(params.name)
  const origin = firstParam(params.origin)
  const executionHost = useWorkspaceExecutionHost()
  const routeParams = {
    ...(name === '' ? {} : { name }),
    ...(origin === '' ? {} : { origin }),
    ...workspaceRouteParams(executionHost)
  }

  const route =
    hostId && worktreeId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/agent-history/${encodeURIComponent(worktreeId)}`,
          // Omit absent name: name= is an explicit label, while absence lets the panel derive one.
          ...(Object.keys(routeParams).length === 0 ? {} : { params: routeParams })
        })
      : null
  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  // Key by route to dispose the old grant-bearing bridge and await fresh init; prop changes would retain the previous route’s grants.
  return <MobileWebShellScreen key={route.pathname} hostId={hostId} route={route} />
})
