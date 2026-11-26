import { useLocalSearchParams } from 'expo-router'
import { MobileWebShellScreen } from '../../../../src/mobile-web-shell/MobileWebShellScreen'
import { shellScreenRoute } from '../../../../src/mobile-web-shell/routing/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../../../src/mobile-web-shell/presentation/PageRouteUnavailableScreen'
import { firstParam } from '../../../../src/navigation/route-param-reader'

// The room runs on the page like a chat, where photos are shrunk before they upload.
export default function MobileBotGroupRoute() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    groupId?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const groupId = firstParam(params.groupId)
  const route =
    hostId && groupId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/group/${encodeURIComponent(groupId)}`
        })
      : null
  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  // Keyed on the room: a session keeps the grants and route it opened with.
  return <MobileWebShellScreen key={route.pathname} hostId={hostId} route={route} />
}
