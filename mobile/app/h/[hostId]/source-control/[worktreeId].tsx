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
 * The source-control hub, from the desktop's bundle.
 *
 * The files route's shape, for its reasons: the shell walls a route the bundle does not list or
 * this app's grants do not cover.
 *
 * `pr` and `history` never mount the shell. Both are `Redirect`s into this route, and
 * a redirect inside the page would leave the session bound to a pathname the page has left; left
 * native they replace into this route, which then mounts the shell. One extra native frame.
 */
export default withWorkspaceRoute(function MobileSourceControlScreen() {
  // Through `firstParam` on every param, as the files route does: expo-router answers a repeated
  // query key with an array, and a bare read puts `String(['a','b'])` into the template, where
  // `encodeURIComponent` makes it the single segment `a%2Cb` — which the bridge's segment rule
  // accepts, so the shell opens a page for a workspace nobody has.
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    origin?: string | string[]
    tab?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const name = firstParam(params.name)
  const origin = firstParam(params.origin)
  const tab = firstParam(params.tab)

  // Each omitted rather than empty, and the whole record omitted when none of the three was named:
  // the panel derives its own label, origin and lens from the workspace when the caller named none,
  // where `name=` is a label and `tab=` is a lens named nothing.
  const executionHost = useWorkspaceExecutionHost()
  const routeParams = {
    ...(name === '' ? {} : { name }),
    ...(origin === '' ? {} : { origin }),
    ...(tab === '' ? {} : { tab }),
    ...workspaceRouteParams(executionHost)
  }
  const route =
    hostId && worktreeId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/source-control/${encodeURIComponent(worktreeId)}`,
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
