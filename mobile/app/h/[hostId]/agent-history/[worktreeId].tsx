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

/**
 * Agent session history, from the desktop's bundle.
 *
 * Two dynamic segments rather than one, so both are encoded: `useLocalSearchParams` answers the
 * decoded value, and a worktree id or a deep-linked host id carrying `/`, `?`, `#` or whitespace
 * would otherwise stop being the single segment `matchesRoutePattern` reads it as.
 *
 * Encoding does not save a `.` or `..` id, and that pathname fails the bridge's own segment rule,
 * which the page would answer with "Update Orca to open this workspace". So the route asks the
 * schema first (through `shellScreenRoute`) and refuses here when the answer is no.
 */
export default withWorkspaceRoute(function MobileAgentSessionHistoryScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const name = firstParam(params.name)
  const executionHost = useWorkspaceExecutionHost()
  const routeParams = {
    ...(name === '' ? {} : { name }),
    ...workspaceRouteParams(executionHost)
  }

  const route =
    hostId && worktreeId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/agent-history/${encodeURIComponent(worktreeId)}`,
          // Omitted rather than empty: the page reads the label off the search half, and a `name=`
          // with nothing after it is a label, where an absent one lets the panel derive its own.
          ...(Object.keys(routeParams).length === 0 ? {} : { params: routeParams })
        })
      : null
  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  // Keyed on the route: a host captures the grants its session was opened with, so a screen
  // reused across a route change would keep authorising frames under the grants of the route the
  // page has left. The key is what makes the change a remount, which disposes that bridge in the
  // commit, and the new session starts with no grants until its own `init`.
  return <MobileWebShellScreen key={route.pathname} hostId={hostId} route={route} />
})
