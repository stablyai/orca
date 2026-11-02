import { useLocalSearchParams } from 'expo-router'
import { firstParam } from '../navigation/route-param-reader'
import { shellScreenRoute, shellScreenRouteKey } from './shell-screen-route'
import { MobileWebShellScreen } from './MobileWebShellScreen'
import { PageRouteUnavailableScreen } from './PageRouteUnavailableScreen'

// Hand unknown host-scoped routes to the shell so newer desktop bundles can serve screens absent from this app; appNamesRoute:false avoids blaming the desktop for stale deep links.
// Keep platform siblings under src: Expo Router 55 parses the dots in [...page].web.tsx as an empty platform, while Metro resolves the plain stem correctly here. Re-encode decoded route segments.
export default function MobileWebPageCatchAllScreen() {
  const params = useLocalSearchParams<Record<string, string | string[]>>()
  const hostId = firstParam(params.hostId)
  const segments = Array.isArray(params.page) ? params.page : params.page ? [params.page] : []

  // Forward query keys except pathname segments and Expo’s fragment key #. Use firstParam to avoid array coercion; preserve empty strings because this catch-all cannot interpret another screen’s state.
  const query = Object.fromEntries(
    Object.entries(params)
      .filter(([key]) => key !== 'hostId' && key !== 'page' && key !== '#')
      .map(([key, value]) => [key, firstParam(value)])
  )

  const route =
    hostId && segments.length > 0
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/${segments.map(encodeURIComponent).join('/')}`,
          ...(Object.keys(query).length === 0 ? {} : { params: query })
        })
      : null

  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  // Remount by route so the captured grants cannot authorize the previous screen’s session. Preserve shell offline/checking/wall states instead of misreporting them as missing routes.
  return (
    <MobileWebShellScreen
      key={shellScreenRouteKey(route)}
      hostId={hostId}
      route={route}
      appNamesRoute={false}
    />
  )
}
