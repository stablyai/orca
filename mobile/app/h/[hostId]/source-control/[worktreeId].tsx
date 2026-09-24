import { useLocalSearchParams } from 'expo-router'
import { MobileSourceControlPanel } from '../../../../src/source-control/MobileSourceControlPanel'
import { firstParam } from '../../../../src/navigation/route-param-reader'
import { parseSourceControlHubTab } from '../../../../src/source-control/mobile-source-control-hub-tab'
import {
  shellScreenRoute,
  shellScreenRouteKey
} from '../../../../src/mobile-web-shell/shell-screen-route'
import { MobileWebShellScreen } from '../../../../src/mobile-web-shell/MobileWebShellScreen'
import { ShellSwitchPendingScreen } from '../../../../src/mobile-web-shell/ShellSwitchPendingScreen'
import { useShellSwitchDecision } from '../../../../src/mobile-web-shell/shell-switch-decision'

/**
 * The source-control hub, from the desktop's bundle or from this app.
 *
 * The files switch's shape, for its reasons: the shell answers `native-route` for a route the
 * bundle does not list or this app's grants do not cover, and `fallback` is what that renders.
 * A flag read still settling is a third answer and paints neither renderer; see
 * `shell-switch-decision.ts`.
 *
 * `pr` and `history` are not switched and never will be. Both are `Redirect`s into this route, and
 * a redirect inside the page would leave the session bound to a pathname the page has left; left
 * native they replace into this route, whose switch then mounts the shell. One extra native frame.
 */
export default function MobileSourceControlScreen() {
  // Through `firstParam` on every param, as the files switch does: expo-router answers a repeated
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
  const native = (
    <MobileSourceControlPanel
      hostId={hostId}
      worktreeId={worktreeId}
      name={name}
      origin={origin}
      initialTab={parseSourceControlHubTab(tab)}
      embedded={false}
    />
  )

  // Each omitted rather than empty, and the whole record omitted when none of the three was named:
  // the panel derives its own label, origin and lens from the workspace when the caller named none,
  // where `name=` is a label and `tab=` is a lens named nothing.
  const routeParams = {
    ...(name === '' ? {} : { name }),
    ...(origin === '' ? {} : { origin }),
    ...(tab === '' ? {} : { tab })
  }
  const route =
    hostId && worktreeId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/source-control/${encodeURIComponent(worktreeId)}`,
          ...(Object.keys(routeParams).length === 0 ? {} : { params: routeParams })
        })
      : null

  const decision = useShellSwitchDecision(route)

  if (decision.kind === 'pending') {
    return <ShellSwitchPendingScreen />
  }
  if (decision.kind === 'native') {
    return native
  }
  // Keyed on the route: a host captures the grants its session was opened with, so a screen reused
  // across a route change would keep authorising frames under the grants of the route the page has
  // left. The key is what makes the change a remount, which disposes that bridge in the commit.
  return (
    <MobileWebShellScreen
      key={shellScreenRouteKey(decision.route)}
      hostId={hostId}
      route={decision.route}
      fallback={native}
    />
  )
}
