import { useLocalSearchParams } from 'expo-router'
import { MobileWebShellScreen } from '../../../../../src/mobile-web-shell/MobileWebShellScreen'
import { shellScreenRoute } from '../../../../../src/mobile-web-shell/routing/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../../../../src/mobile-web-shell/presentation/PageRouteUnavailableScreen'
import { firstParam } from '../../../../../src/navigation/route-param-reader'

// An agent shared with the computer's account: its page runs on the phone's own link to its host.
export default function MobileSharedAgentRoute() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    environmentId?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const environmentId = firstParam(params.environmentId)
  const route =
    hostId && environmentId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/shared/${encodeURIComponent(environmentId)}`
        })
      : null
  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  return <MobileWebShellScreen key={route.pathname} hostId={hostId} route={route} />
}
