import { useLocalSearchParams } from 'expo-router'
import { MobileFileExplorerPanel } from '../../../../src/files/MobileFileExplorerPanel'
import { firstParam } from '../../../../src/source-control/mobile-source-control-screen-state'
import {
  shellScreenRoute,
  shellScreenRouteKey
} from '../../../../src/mobile-web-shell/shell-screen-route'
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
  // Through `firstParam`, as the tasks and agent-history switches do: expo-router answers a
  // repeated query key with an array, and a bare read puts it straight into the template, where
  // `String(['a','b'])` is `a,b` and `encodeURIComponent` makes it the single segment `a%2Cb` —
  // which the bridge's segment rule accepts, so the shell opens a page for a host nobody has.
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const name = firstParam(params.name)
  const enabled = useMobileWebShellEnabled()
  const native = (
    <MobileFileExplorerPanel hostId={hostId} worktreeId={worktreeId} name={name} embedded={false} />
  )

  const route =
    hostId && worktreeId
      ? shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}/files/${encodeURIComponent(worktreeId)}`,
          // Omitted rather than empty: the panel derives its own label from the worktree id when
          // the caller named none, where `name=` with nothing after it is a label.
          ...(name === '' ? {} : { params: { name } })
        })
      : null

  if (enabled !== true || !hostId || route === null) {
    return native
  }
  // Keyed on the route: a host captures the grants its session was opened with, so a screen reused
  // across a route change would keep authorising frames under the grants of the route the page has
  // left. The key is what makes the change a remount, which disposes that bridge in the commit.
  return (
    <MobileWebShellScreen
      key={shellScreenRouteKey(route)}
      hostId={hostId}
      route={route}
      fallback={native}
    />
  )
}
