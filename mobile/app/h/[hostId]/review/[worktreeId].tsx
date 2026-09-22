import { useLocalSearchParams } from 'expo-router'
import { MobileDiffReviewRouteScreen } from '../../../../src/session/MobileDiffReviewRouteScreen'
import { firstReviewParam } from '../../../../src/session/mobile-diff-review-screen-model'
import {
  shellScreenRoute,
  shellScreenRouteKey
} from '../../../../src/mobile-web-shell/shell-screen-route'
import { MobileWebShellScreen } from '../../../../src/mobile-web-shell/MobileWebShellScreen'
import { ShellSwitchPendingScreen } from '../../../../src/mobile-web-shell/ShellSwitchPendingScreen'
import { useShellSwitchDecision } from '../../../../src/mobile-web-shell/shell-switch-decision'

/**
 * Diff review, from the desktop's bundle or from this app.
 *
 * The files switch's shape. What is different here is that the native screen is a component rather
 * than the body of this file: `MobileDiffReviewRouteScreen` calls the review controller, and a
 * controller at this file's top level would subscribe behind the page as well as in front of it.
 * As an element it is built and not mounted, and only `fallback` ever mounts it.
 *
 * `matchesRoutePattern` is segment-count exact with literal equality on the static segments, so
 * these five segments collide with nothing: the explorer's five carry `files`.
 */
export default function MobileDiffReviewScreen() {
  // Through `firstReviewParam`, which is this domain's spelling of the rule every switch follows:
  // expo-router answers a repeated query key with an array, and a bare read would build a single
  // segment out of `String(['a','b'])` that the bridge's segment rule accepts.
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    scope?: string | string[]
    file?: string | string[]
    area?: string | string[]
  }>()
  const hostId = firstReviewParam(params.hostId)
  const worktreeId = firstReviewParam(params.worktreeId)
  const native = <MobileDiffReviewRouteScreen />

  // The four query params are read by the screen itself, so they are carried across whole rather
  // than re-derived here; each is omitted when empty, because the screen's own normalizers treat an
  // absent scope, file or area differently from one named nothing.
  const routeParams = Object.fromEntries(
    (['name', 'scope', 'file', 'area'] as const)
      .map((key) => [key, firstReviewParam(params[key])] as const)
      .filter(([, value]) => value !== '')
  )
  const route =
    hostId && worktreeId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/review/${encodeURIComponent(worktreeId)}`,
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
  // left. A `file` change is the common case here and is a param change, not a path change.
  return (
    <MobileWebShellScreen
      key={shellScreenRouteKey(decision.route)}
      hostId={hostId}
      route={decision.route}
      fallback={native}
    />
  )
}
