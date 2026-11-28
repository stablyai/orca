import { useLocalSearchParams } from 'expo-router'
import { MobileWebShellScreen } from '../../../../../src/mobile-web-shell/MobileWebShellScreen'
import { shellScreenRoute } from '../../../../../src/mobile-web-shell/routing/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../../../../src/mobile-web-shell/presentation/PageRouteUnavailableScreen'
import { firstParam } from '../../../../../src/navigation/route-param-reader'

// One of a teammate's chats with a shared agent, the regular chat on the page.
export default function MobileSharedAgentChatRoute() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    environmentId?: string | string[]
    sessionId?: string | string[]
    title?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const environmentId = firstParam(params.environmentId)
  const sessionId = firstParam(params.sessionId)
  const title = firstParam(params.title)
  const route =
    hostId && environmentId && sessionId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/shared/${encodeURIComponent(environmentId)}/${encodeURIComponent(sessionId)}`,
          ...(title ? { params: { title } } : {})
        })
      : null
  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  // Keyed on the chat: a session keeps the grants and route it opened with.
  return <MobileWebShellScreen key={route.pathname} hostId={hostId} route={route} />
}
