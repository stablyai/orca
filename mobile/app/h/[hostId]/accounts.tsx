import { useLocalSearchParams } from 'expo-router'
import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'
import { shellScreenRoute } from '../../../src/mobile-web-shell/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { firstParam } from '../../../src/navigation/route-param-reader'

/** The shell route for the host's agent accounts, in `tasks.tsx`'s shape. */
export default function MobileAccountsRoute() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)

  const route = hostId
    ? shellScreenRoute({ pathname: `/h/${encodeURIComponent(hostId)}/accounts` })
    : null
  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  // Keyed on the host: a session keeps the grants it opened with, so a new host is a remount.
  return <MobileWebShellScreen key={hostId} hostId={hostId} route={route} />
}
