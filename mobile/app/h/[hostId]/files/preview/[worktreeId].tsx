import { withWorkspaceRoute } from '../../../../../src/navigation/workspace-route'
import {
  useWorkspaceExecutionHost,
  workspaceRouteParams
} from '../../../../../src/navigation/workspace-execution-host'
import { useLocalSearchParams } from 'expo-router'
import {
  mobileFilePreviewShellParams,
  normalizeMobileFilePreviewRouteParams
} from '../../../../../src/files/mobile-file-preview-route'
import {
  shellScreenRoute,
  shellScreenRouteKey
} from '../../../../../src/mobile-web-shell/shell-screen-route'
import { MobileWebShellScreen } from '../../../../../src/mobile-web-shell/MobileWebShellScreen'
import { PageRouteUnavailableScreen } from '../../../../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { firstParam } from '../../../../../src/navigation/route-param-reader'

// Normalize preview route before opening shell; rejected params must not mount a page that rejects them again.
// Only host/worktree ids are path segments; file paths stay params so /, spaces and dot-dot never enter the bridge’s segment vocabulary.
export default withWorkspaceRoute(function MobileFilePreviewRoute() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    relativePath?: string | string[]
    source?: string | string[]
    absolutePath?: string | string[]
    grantId?: string | string[]
    terminal?: string | string[]
    pathText?: string | string[]
    cwd?: string | string[]
    nativeChatTab?: string | string[]
    nativeChatSession?: string | string[]
    line?: string | string[]
    column?: string | string[]
    name?: string | string[]
    worktreeName?: string | string[]
  }>()
  const route = normalizeMobileFilePreviewRouteParams(params)
  const executionHost = useWorkspaceExecutionHost()

  const shellRoute = route.ok
    ? shellScreenRoute({
        pathname: `/h/${encodeURIComponent(route.params.hostId)}/files/preview/${encodeURIComponent(
          route.params.worktreeId
        )}`,
        params: {
          ...mobileFilePreviewShellParams(route.params),
          ...workspaceRouteParams(executionHost)
        }
      })
    : null

  // Repeat route.ok for narrowing: shellRoute was built only on this branch.
  if (shellRoute === null || !route.ok) {
    return <PageRouteUnavailableScreen hostId={firstParam(params.hostId)} />
  }
  // Key by full route including params: remount drops old grants and re-inits the page, which learns its file only once from init.
  return (
    <MobileWebShellScreen
      key={shellScreenRouteKey(shellRoute)}
      hostId={route.params.hostId}
      route={shellRoute}
    />
  )
})
