import { useLocalSearchParams } from 'expo-router'
import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'
import {
  shellScreenRoute,
  shellScreenRouteKey
} from '../../../src/mobile-web-shell/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { firstParam } from '../../../src/navigation/route-param-reader'

export default function MobileAutomationsRoute() {
  const params = useLocalSearchParams<{ hostId?: string | string[]; new?: string | string[] }>()
  const hostId = firstParam(params.hostId)
  // new=1 opens the page on a new automation's editor.
  const create = firstParam(params.new)
  const route = hostId
    ? shellScreenRoute({
        pathname: `/h/${encodeURIComponent(hostId)}/automations`,
        ...(create === '' ? {} : { params: { new: create } })
      })
    : null
  if (!route) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  return <MobileWebShellScreen key={shellScreenRouteKey(route)} hostId={hostId} route={route} />
}
