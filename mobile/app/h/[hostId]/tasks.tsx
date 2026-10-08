import { useLocalSearchParams } from 'expo-router'
import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'
import { ShellSwitchPendingScreen } from '../../../src/mobile-web-shell/ShellSwitchPendingScreen'
import { shellScreenRoute } from '../../../src/mobile-web-shell/shell-screen-route'
import { useShellSwitchDecision } from '../../../src/mobile-web-shell/shell-switch-decision'
import { firstParam } from '../../../src/navigation/route-param-reader'
import { MobileTasksScreen } from '../../../src/tasks/MobileTasksScreen'

/**
 * The shell's switch for this route, in `index.tsx`'s shape.
 *
 * The page is opened from the native home screen, so the pathname and the provider param are what
 * the shell tells it; `taskSource` rides in `init.route.params`, which the page folds back into
 * its own URL before the first render.
 */
export default function MobileTasksRoute() {
  // Through `firstParam`, as the agent-history switch does: expo-router hands back an array for a
  // repeated query key, and a bare read builds `/h/host-a%2Chost-b/tasks` out of one.
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    taskSource?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const taskSource = firstParam(params.taskSource)
  const native = <MobileTasksScreen />

  // Built before the decision rather than after it, as every switch does now: the decision needs
  // to know whether the shell is a possible outcome before it can say a neutral frame is owed.
  const route = hostId
    ? shellScreenRoute({
        pathname: `/h/${encodeURIComponent(hostId)}/tasks`,
        // Omitted rather than empty: an absent provider lets the page pick its own default, where
        // `taskSource=` is a provider named nothing.
        ...(taskSource === '' ? {} : { params: { taskSource } })
      })
    : null
  const decision = useShellSwitchDecision(route)

  if (decision.kind === 'pending') {
    return <ShellSwitchPendingScreen />
  }
  if (decision.kind === 'native') {
    return native
  }
  return (
    <MobileWebShellScreen
      // Keyed for the reason every shell route is: a host holds the grants its session opened
      // with, so a host id change must be a remount rather than a prop update.
      key={hostId}
      hostId={hostId}
      route={decision.route}
      fallback={native}
    />
  )
}
