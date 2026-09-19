import { useLocalSearchParams } from 'expo-router'
import { WorkspaceDetailPlaceholder } from '../../../src/components/WorkspaceDetailPlaceholder'
import { HostScreen } from '../../../src/host-screen/HostScreen'
import { useResponsiveLayout } from '../../../src/layout/responsive-layout'
import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'
import { useMobileWebShellEnabled } from '../../../src/mobile-web-shell/use-mobile-web-shell-enabled'

/**
 * The worktree list, from the desktop's bundle or from this app.
 *
 * The shell decides, not this switch: it renders the page only for a route the bundle lists with
 * grants this app implements, and answers `native-route` otherwise, which is what `fallback` is.
 * So the two ways to stay native are a flag that is off and a negotiation that said no, and the
 * second one covers every host whose desktop is older than the page.
 *
 * `enabled === null` is the flag read still settling, and it renders the native screen: a store
 * build never reaches storage at all, so that is the only frame it ever paints here.
 *
 * Encoded, not interpolated raw, for the reason `web.tsx` states: a deep-linked host id carrying
 * `?`, `#` or whitespace would build a pathname the page refuses, and a refusal here is a failure
 * screen rather than the native list this route already has.
 */
function HostListScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const enabled = useMobileWebShellEnabled()

  if (enabled !== true || !hostId) {
    return <HostScreen />
  }
  return (
    <MobileWebShellScreen
      // Same reason as the agent-history route: a host holds the grants its session opened with,
      // so a host id change must be a remount rather than a prop update.
      key={hostId}
      hostId={hostId}
      route={{ pathname: `/h/${encodeURIComponent(hostId)}` }}
      fallback={<HostScreen />}
    />
  )
}

// On wide layouts the sidebar hosts the list, so this route is just the empty detail pane.
export default function HostWorktreeRoute() {
  const { isWideLayout } = useResponsiveLayout()
  if (isWideLayout) {
    return <WorkspaceDetailPlaceholder />
  }
  return <HostListScreen />
}
