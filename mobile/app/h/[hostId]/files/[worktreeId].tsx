import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import {
  useWorkspaceExecutionHost,
  workspaceRouteParams
} from '../../../../src/navigation/workspace-execution-host'
import { useLocalSearchParams } from 'expo-router'
import { firstParam } from '../../../../src/navigation/route-param-reader'
import {
  shellScreenRoute,
  shellScreenRouteKey
} from '../../../../src/mobile-web-shell/shell-screen-route'
import { MobileWebShellScreen } from '../../../../src/mobile-web-shell/MobileWebShellScreen'
import { PageRouteUnavailableScreen } from '../../../../src/mobile-web-shell/PageRouteUnavailableScreen'

// Encode decoded ids so ?, # and whitespace cannot form a pathname the page refuses; shell gates unsupported bundles.
export default withWorkspaceRoute(function MobileFileExplorerScreen() {
  // Use firstParam: repeated query keys are arrays; encoding String(array) would create a valid segment naming a nonexistent host.
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const name = firstParam(params.name)
  const executionHost = useWorkspaceExecutionHost()
  const routeParams = {
    ...(name === '' ? {} : { name }),
    ...workspaceRouteParams(executionHost)
  }

  const route =
    hostId && worktreeId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/files/${encodeURIComponent(worktreeId)}`,
          // Omit absent name so panel derives its label; name= is an explicit label.
          ...(Object.keys(routeParams).length === 0 ? {} : { params: routeParams })
        })
      : null

  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  // Key by route to dispose the old grant-bearing bridge; prop changes would retain the previous route’s grants.
  return <MobileWebShellScreen key={shellScreenRouteKey(route)} hostId={hostId} route={route} />
})
