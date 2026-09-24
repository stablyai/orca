import { useCallback } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { MobileSessionRouteScreen } from '../../../../src/session/MobileSessionRouteScreen'
import { firstParam } from '../../../../src/navigation/route-param-reader'
import {
  shellScreenRoute,
  shellScreenRouteKey
} from '../../../../src/mobile-web-shell/shell-screen-route'
import { MobileWebShellScreen } from '../../../../src/mobile-web-shell/MobileWebShellScreen'
import { ShellSwitchPendingScreen } from '../../../../src/mobile-web-shell/ShellSwitchPendingScreen'
import { useShellSwitchDecision } from '../../../../src/mobile-web-shell/shell-switch-decision'

/**
 * The session screen — terminal and chat — from the desktop's bundle or from this app.
 *
 * The review switch's shape, for its reasons: the native screen is `MobileSessionRouteScreen`
 * rather than the body of this file, because `useMobileSessionController` at this file's top level
 * would open the terminal, chat and tab subscriptions behind the page as well as in front of it.
 * As an element it is built and not mounted, and only `fallback` ever mounts it.
 *
 * Four query params rather than the review's four, and one of them is not part of this screen's
 * identity: `paneKey`. A notification tap for a pane of the session already on screen is a tab
 * switch, so keying on it would tear the bridge down and reload the page for one, and keying on it
 * while the page cleared its own copy lost a repeat tap outright (ruling 33.1). It travels as a
 * route update instead — a re-sent `init` to a page that said it takes one — and this file clears
 * the native param once the page has been handed it, exactly as the notification hook did, so no
 * later `init` can replay a spent tap.
 */
export default function MobileSessionScreen() {
  // Through `firstParam` on every param, as every switch does: expo-router answers a repeated query
  // key with an array, and a bare read puts `String(['a','b'])` into the template, where
  // `encodeURIComponent` makes it the single segment `a%2Cb` — which the bridge's segment rule
  // accepts, so the shell opens a page for a workspace nobody has.
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    created?: string | string[]
    warning?: string | string[]
    paneKey?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const router = useRouter()
  const native = <MobileSessionRouteScreen />
  const paneKey = firstParam(params.paneKey) ?? ''
  // The reader erasing its own request (ruling 34): the page applied a pane and names it back, and
  // this is where the param it came on lives. Compared rather than obeyed — a tap that moved on
  // while the page was applying the one before it leaves a newer key here, and that one is not
  // spent yet. Written empty rather than removed, which is what the notification hook wrote and
  // what the route builder below drops: a cleared key and a key that was never there are the same
  // route.
  const erasePaneKey = useCallback(
    (param: 'paneKey', value: string) => {
      if (param !== 'paneKey' || paneKey === '' || value !== paneKey) {
        return
      }
      router.setParams({ paneKey: '' })
    },
    [paneKey, router]
  )

  // Each omitted when empty, because the screen reads the difference: `created` is a one-shot flag
  // the create flow sets to `1`, `warning` is the host's own text, `name` is a label the screen
  // otherwise derives from the workspace, and `paneKey` empty is exactly what the notification hook
  // writes back to say the tap is spent.
  const routeParams = Object.fromEntries(
    (['name', 'created', 'warning', 'paneKey'] as const)
      .map((key) => [key, firstParam(params[key])] as const)
      .filter(([, value]) => value !== '')
  )
  const route =
    hostId && worktreeId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktreeId)}`,
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
  // Keyed on the route minus `paneKey`: a host captures the grants its session was opened with, so
  // a screen reused across a route change would keep authorising frames under the grants of the
  // route the page has left, and the key is what makes that change a remount. A pane is not such a
  // change — it is a tab of the session this key already names — so it is left out here and
  // delivered to the mounted page instead. Derived from the same builder every other switch uses;
  // `shellScreenRouteKey` is untouched, because for the other four a param change *is* an identity
  // change.
  const { paneKey: _paneKey, ...identity } = routeParams
  return (
    <MobileWebShellScreen
      key={shellScreenRouteKey({ pathname: decision.route.pathname, params: identity })}
      hostId={hostId}
      route={decision.route}
      fallback={native}
      onRouteParamClear={erasePaneKey}
    />
  )
}
