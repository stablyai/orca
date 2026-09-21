import { Redirect, useLocalSearchParams } from 'expo-router'
import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'
import { ShellSwitchPendingScreen } from '../../../src/mobile-web-shell/ShellSwitchPendingScreen'
import { useShellSwitchDecision } from '../../../src/mobile-web-shell/shell-switch-decision'

/**
 * The hybrid shell route, dark behind a development-only flag.
 *
 * With the flag off — which is every store build, since the only writer is the `__DEV__`
 * Troubleshoot toggle — this redirects and the screen is never constructed, so nothing is fetched,
 * written or swept. It sits under `app/h/[hostId]` so `HostProtocolGate` in that group's layout
 * still owns the `desktop-too-old` wall above it.
 *
 * Reachable by deep link and from the developer row only; no screen links here.
 */
export default function MobileWebShellRoute() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  // Encoded here rather than in the JSX below so the decision holds the route the shell is handed:
  // `hostId` arrives decoded from the URL, so one carrying `?`, `#` or whitespace would build a
  // pathname the page refuses and never mount anything.
  const decision = useShellSwitchDecision(
    hostId ? { pathname: `/h/${encodeURIComponent(hostId)}` } : null
  )

  if (decision.kind === 'pending') {
    // A redirect fired before the read settles would bounce a flag that is on, and a screen mounted
    // before it settles would fetch on a flag that is off. Neither, until it is known.
    return <ShellSwitchPendingScreen />
  }
  if (decision.kind === 'native') {
    return <Redirect href={`/h/${hostId ?? ''}`} />
  }
  // The screen the page stands in for. The document is served at `/`, which matches no route in
  // the tree the page carries, so this is the only thing that tells it which one to open.
  //
  // The fallback is a redirect rather than the native screen: this route exists only to open the
  // page deliberately, so a bundle that does not list the worktree list has nothing to show here
  // and the host route is where the list actually lives.
  return (
    <MobileWebShellScreen
      // Same reason as the agent-history route: a host holds the grants its session opened with,
      // so a host id change must be a remount rather than a prop update.
      key={hostId}
      hostId={hostId}
      route={decision.route}
      fallback={<Redirect href={`/h/${hostId}`} />}
    />
  )
}
