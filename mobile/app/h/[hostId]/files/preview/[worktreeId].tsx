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

/**
 * The file preview, from the desktop's bundle.
 *
 * Normalized before the shell route is built, not after: a route the preview would refuse is one the shell has no
 * pathname to build from, and a refusal here beats a page opened on params it will refuse again.
 *
 * Only the two path segments are spelled into the pathname; everything else — the file path among
 * them — is a param, which is what keeps a `/`, a space or a `..` out of the segment vocabulary the
 * bridge holds a route to.
 */
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

  // `route.ok` again for the compiler: `shellRoute` is built only on the ok branch.
  if (shellRoute === null || !route.ok) {
    return <PageRouteUnavailableScreen hostId={firstParam(params.hostId)} />
  }
  // Keyed on the whole route, params included, for two reasons. A host captures the grants its
  // session was opened with, so only a remount drops the bridge the previous route opened. And the
  // page learns its route exactly once, from `init`: a same-path param change — another file in
  // this worktree — would otherwise leave the shell mounted and the page still showing the file it
  // was opened on, with nothing to tell it otherwise.
  return (
    <MobileWebShellScreen
      key={shellScreenRouteKey(shellRoute)}
      hostId={route.params.hostId}
      route={shellRoute}
    />
  )
})
