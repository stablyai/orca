import { useLocalSearchParams } from 'expo-router'
import { MobileAgentSessionHistoryPanel } from '../../../../src/agent-history/MobileAgentSessionHistoryPanel'
import { MobileWebShellScreen } from '../../../../src/mobile-web-shell/MobileWebShellScreen'
import { ShellSwitchPendingScreen } from '../../../../src/mobile-web-shell/ShellSwitchPendingScreen'
import { shellScreenRoute } from '../../../../src/mobile-web-shell/shell-screen-route'
import { useShellSwitchDecision } from '../../../../src/mobile-web-shell/shell-switch-decision'
import { firstParam } from '../../../../src/navigation/route-param-reader'

/**
 * Agent session history, from the desktop's bundle or from this app.
 *
 * The switch is `index.tsx`'s, for its reasons: the shell renders the page only for a route the
 * bundle lists with grants this app implements, `fallback` is what a negotiation that said no
 * falls back to, and a flag read still settling paints neither renderer.
 *
 * Two dynamic segments rather than one, so both are encoded: `useLocalSearchParams` answers the
 * decoded value, and a worktree id or a deep-linked host id carrying `/`, `?`, `#` or whitespace
 * would otherwise stop being the single segment `matchesRoutePattern` reads it as. A route with no
 * worktree names no screen the shell could open, so it stays native.
 *
 * Encoding does not save a `.` or `..` id, which it leaves unchanged, and that pathname fails the
 * bridge's own segment rule. Handing it over anyway reaches the phone as an `init` naming no
 * screen, which the page answers with "Update Orca to open this workspace" — a failure screen in
 * place of the native panel sitting right behind this switch. So the route asks the schema first
 * and stays native when the answer is no, which is where every route starts.
 *
 * The schema is the predicate rather than a copy of its bounds: two spellings of one rule drift,
 * and the half that matters is the half the page reads. C3.1 made the same call for the files
 * routes first, and every switch now asks the one module beside the schema
 * rather than carrying its own copy of the call.
 */
export default function MobileAgentSessionHistoryScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const name = firstParam(params.name)
  const panel = (
    <MobileAgentSessionHistoryPanel hostId={hostId} worktreeId={worktreeId} name={name} />
  )

  // Built before the decision rather than after it, as every switch does now: the decision needs
  // to know whether the shell is a possible outcome before it can say a neutral frame is owed.
  const route =
    hostId && worktreeId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/agent-history/${encodeURIComponent(worktreeId)}`,
          // Omitted rather than empty: the page reads the label off the search half, and a `name=`
          // with nothing after it is a label, where an absent one lets the panel derive its own.
          ...(name === '' ? {} : { params: { name } })
        })
      : null
  const decision = useShellSwitchDecision(route)

  if (decision.kind === 'pending') {
    return <ShellSwitchPendingScreen />
  }
  if (decision.kind === 'native') {
    return panel
  }
  // Keyed on the route: a host captures the grants its session was opened with, so a screen
  // reused across a route change would keep authorising frames under the grants of the route the
  // page has left. The key is what makes the change a remount, which disposes that bridge in the
  // commit, and the new session starts with no grants until its own `init`.
  return (
    <MobileWebShellScreen
      key={decision.route.pathname}
      hostId={hostId}
      route={decision.route}
      fallback={panel}
    />
  )
}
