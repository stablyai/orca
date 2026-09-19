import { useLocalSearchParams } from 'expo-router'
import { MobileFilePreviewScreen } from '../../../../../src/files/MobileFilePreviewScreen'
import {
  mobileFilePreviewShellParams,
  normalizeMobileFilePreviewRouteParams
} from '../../../../../src/files/mobile-file-preview-route'
import {
  shellScreenRoute,
  shellScreenRouteKey
} from '../../../../../src/mobile-web-shell/shell-screen-route'
import { MobileWebShellScreen } from '../../../../../src/mobile-web-shell/MobileWebShellScreen'
import { useMobileWebShellEnabled } from '../../../../../src/mobile-web-shell/use-mobile-web-shell-enabled'

/**
 * The file preview, from the desktop's bundle or from this app.
 *
 * Normalized before the switch, not after: a route the native screen would refuse is one the shell
 * has no pathname to build from, and its own refusal message is a better screen than a page opened
 * on params it will refuse again.
 *
 * Only the two path segments are spelled into the pathname; everything else — the file path among
 * them — is a param, which is what keeps a `/`, a space or a `..` out of the segment vocabulary the
 * bridge holds a route to.
 */
export default function MobileFilePreviewRoute() {
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
  const enabled = useMobileWebShellEnabled()
  const native = <MobileFilePreviewScreen route={route} />

  const shellRoute = route.ok
    ? shellScreenRoute({
        pathname: `/h/${encodeURIComponent(route.params.hostId)}/files/preview/${encodeURIComponent(
          route.params.worktreeId
        )}`,
        params: mobileFilePreviewShellParams(route.params)
      })
    : null

  if (enabled !== true || !route.ok || shellRoute === null) {
    return native
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
      fallback={native}
    />
  )
}
