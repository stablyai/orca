import { useLocalSearchParams } from 'expo-router'
import { MobileFileExplorerPanel } from '../../../../src/files/MobileFileExplorerPanel'
import { mobileFileShellRoute } from '../../../../src/files/mobile-file-shell-route'
import { MobileWebShellScreen } from '../../../../src/mobile-web-shell/MobileWebShellScreen'
import { useMobileWebShellEnabled } from '../../../../src/mobile-web-shell/use-mobile-web-shell-enabled'

/**
 * The file explorer, from the desktop's bundle or from this app.
 *
 * The shell decides, not this switch: it renders the page only for a route the bundle lists with
 * grants this app implements, and answers `native-route` otherwise, which is what `fallback` is.
 * `enabled === null` is the flag read still settling and renders the native screen, which is the
 * only frame a store build ever paints here.
 *
 * Encoded, not interpolated raw, for the reason `web.tsx` states: an id carrying `?`, `#` or
 * whitespace would build a pathname the page refuses and mount nothing.
 */
export default function MobileFileExplorerScreen() {
  const { hostId, worktreeId, name } = useLocalSearchParams<{
    hostId: string
    worktreeId: string
    name?: string
  }>()
  const enabled = useMobileWebShellEnabled()
  const native = (
    <MobileFileExplorerPanel hostId={hostId} worktreeId={worktreeId} name={name} embedded={false} />
  )

  const route =
    hostId && worktreeId
      ? mobileFileShellRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/files/${encodeURIComponent(worktreeId)}`,
          ...(name === undefined ? {} : { params: { name } })
        })
      : null

  if (enabled !== true || !hostId || route === null) {
    return native
  }
  return <MobileWebShellScreen hostId={hostId} route={route} fallback={native} />
}
