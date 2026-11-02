import { useLocalSearchParams } from 'expo-router'
import { firstParam } from '../../../src/navigation/route-param-reader'
import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'
import { shellScreenRoute } from '../../../src/mobile-web-shell/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../../src/mobile-web-shell/PageRouteUnavailableScreen'

/**
 * The worktree list, from the desktop's bundle. The shell walls a host whose bundle cannot serve it.
 *
 * Encoded, not interpolated raw: `hostId` arrives decoded, and a deep-linked one carrying `?`, `#`
 * or whitespace would build a pathname the page refuses.
 */
function HostListScreen() {
  // Through `firstParam`, as the other route files do: expo-router answers a repeated key with
  // an array, and a bare read puts it straight into the template, where `String(['a','b'])` is
  // `a,b` and `encodeURIComponent` makes it the single segment `a%2Cb` — which the bridge's
  // segment rule accepts, so the shell would open a page for a host nobody has. An empty array is
  // truthy, so a bare read also builds `/h/` and hands that over; this answers `''` and stays.
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)

  // Asked here as every route file asks it: encoding does not save a `.` or `..` host id, which fails
  // the bridge's segment rule.
  const route =
    hostId === '' ? null : shellScreenRoute({ pathname: `/h/${encodeURIComponent(hostId)}` })
  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  return (
    <MobileWebShellScreen
      // Same reason as the agent-history route: a host holds the grants its session opened with,
      // so a host id change must be a remount rather than a prop update.
      key={hostId}
      hostId={hostId}
      route={route}
    />
  )
}

// Wide: the session owns the whole host area when the page declares `canOwnHostArea`.
export default HostListScreen
