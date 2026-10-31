import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import {
  useWorkspaceExecutionHost,
  workspaceRouteParams
} from '../../../../src/navigation/workspace-execution-host'
import { useLocalSearchParams } from 'expo-router'
import { firstParam } from '../../../../src/navigation/route-param-reader'
import {
  shellScreenRoute,
  shellScreenRouteKey
} from '../../../../src/mobile-web-shell/shell-screen-route'
import { MobileWebShellScreen } from '../../../../src/mobile-web-shell/MobileWebShellScreen'
import { PageRouteUnavailableScreen } from '../../../../src/mobile-web-shell/PageRouteUnavailableScreen'

export default withWorkspaceRoute(function MobileCommitDetailScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    sha?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const executionHost = useWorkspaceExecutionHost()

  const routeParams: Record<string, string> = {
    ...Object.fromEntries(
      (['name', 'sha'] as const)
        .map((key) => [key, firstParam(params[key])] as const)
        .filter(([, value]) => value !== '')
    ),
    ...workspaceRouteParams(executionHost)
  }
  const route =
    hostId && worktreeId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/commit/${encodeURIComponent(worktreeId)}`,
          params: routeParams
        })
      : null

  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  // Key by the full route so another commit disposes the old grant-bearing bridge.
  return <MobileWebShellScreen key={shellScreenRouteKey(route)} hostId={hostId} route={route} />
})
