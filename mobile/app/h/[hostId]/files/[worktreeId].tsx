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

/**
 * The file explorer, from the desktop's bundle. The shell walls a host whose bundle cannot serve it.
 *
 * Encoded, not interpolated raw: ids arrive decoded, and one carrying `?`, `#` or whitespace would
 * build a pathname the page refuses and mount nothing.
 */
export default withWorkspaceRoute(function MobileFileExplorerScreen() {
  // Through `firstParam`, as the tasks and agent-history routes do: expo-router answers a
  // repeated query key with an array, and a bare read puts it straight into the template, where
  // `String(['a','b'])` is `a,b` and `encodeURIComponent` makes it the single segment `a%2Cb` —
  // which the bridge's segment rule accepts, so the shell opens a page for a host nobody has.
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
          pathname: `/h/${encodeURIComponent(hostId)}/files/${encodeURIComponent(worktreeId)}`,
          // Omitted rather than empty: the panel derives its own label from the worktree id when
          // the caller named none, where `name=` with nothing after it is a label.
          ...(Object.keys(routeParams).length === 0 ? {} : { params: routeParams })
        })
      : null

  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  // Keyed on the route: a host captures the grants its session was opened with, so a screen reused
  // across a route change would keep authorising frames under the grants of the route the page has
  // left. The key is what makes the change a remount, which disposes that bridge in the commit.
  return <MobileWebShellScreen key={shellScreenRouteKey(route)} hostId={hostId} route={route} />
})
