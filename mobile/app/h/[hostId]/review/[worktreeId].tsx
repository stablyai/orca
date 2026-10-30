import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import {
  useWorkspaceExecutionHost,
  workspaceRouteParams
} from '../../../../src/navigation/workspace-execution-host'
import { useLocalSearchParams } from 'expo-router'
import { firstReviewParam } from '../../../../src/session/mobile-diff-review-screen-model'
import {
  shellScreenRoute,
  shellScreenRouteKey
} from '../../../../src/mobile-web-shell/shell-screen-route'
import { MobileWebShellScreen } from '../../../../src/mobile-web-shell/MobileWebShellScreen'
import { PageRouteUnavailableScreen } from '../../../../src/mobile-web-shell/PageRouteUnavailableScreen'

// Review and explorer routes both have five segments; exact static-segment matching distinguishes review from files.
export default withWorkspaceRoute(function MobileDiffReviewScreen() {
  // Use firstReviewParam: encoding String(array) could turn repeated query keys into a valid but nonexistent workspace segment.
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    scope?: string | string[]
    file?: string | string[]
    area?: string | string[]
  }>()
  const hostId = firstReviewParam(params.hostId)
  const worktreeId = firstReviewParam(params.worktreeId)
  const executionHost = useWorkspaceExecutionHost()

  // Carry screen query params unchanged, omitting empty values: screen normalizers distinguish absence from empty scope/file/area.
  const routeParams: Record<string, string> = {
    ...Object.fromEntries(
      (['name', 'scope', 'file', 'area'] as const)
        .map((key) => [key, firstReviewParam(params[key])] as const)
        .filter(([, value]) => value !== '')
    ),
    ...workspaceRouteParams(executionHost)
  }
  const route =
    hostId && worktreeId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/review/${encodeURIComponent(worktreeId)}`,
          ...(Object.keys(routeParams).length === 0 ? {} : { params: routeParams })
        })
      : null

  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  // Key by full route including file params to dispose the old grant-bearing bridge on route changes.
  return <MobileWebShellScreen key={shellScreenRouteKey(route)} hostId={hostId} route={route} />
})
