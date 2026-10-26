import { useLocalSearchParams } from 'expo-router'
import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'
import { shellScreenRoute } from '../../../src/mobile-web-shell/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { firstParam } from '../../../src/navigation/route-param-reader'

// Pass native pathname and taskSource via init.route.params; page restores its URL before first render.
export default function MobileTasksRoute() {
  // Use firstParam: repeated query keys are arrays and must not form a comma-joined host segment.
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    taskSource?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const taskSource = firstParam(params.taskSource)

  const route = hostId
    ? shellScreenRoute({
        pathname: `/h/${encodeURIComponent(hostId)}/tasks`,
        // Omit absent taskSource so page selects its default; taskSource= is an explicit empty provider.
        ...(taskSource === '' ? {} : { params: { taskSource } })
      })
    : null
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
