import { useLocalSearchParams } from 'expo-router'
import { firstParam } from '../../../src/navigation/route-param-reader'
import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'
import { shellScreenRoute } from '../../../src/mobile-web-shell/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../../src/mobile-web-shell/PageRouteUnavailableScreen'

// Encode decoded hostId so ?, # and whitespace cannot form a pathname the page refuses; shell gates unsupported bundles.
function HostListScreen() {
  // Use firstParam: encoding String(array) creates a valid segment naming a nonexistent host; an empty array is truthy and otherwise builds /h/.
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)

  // Validate through bridge schema: encoding cannot make dot/dot-dot host ids valid.
  const route =
    hostId === '' ? null : shellScreenRoute({ pathname: `/h/${encodeURIComponent(hostId)}` })
  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  return (
    <MobileWebShellScreen
      // Remount on host change to discard the old session’s grants.
      key={hostId}
      hostId={hostId}
      route={route}
    />
  )
}

// Wide: the session owns the whole host area when the page declares `canOwnHostArea`.
export default HostListScreen
