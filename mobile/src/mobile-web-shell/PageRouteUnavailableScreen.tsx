import { Compass } from 'lucide-react-native'
import { hostStackHostRoute } from '../navigation/host-stack-navigation'
import { useRouteHandoff } from '../navigation/route-handoff'
import { ShellStateFrame, ShellStateMessage } from './ShellStateFrame'

/**
 * What a host-scoped pathname nothing can paint lands on.
 *
 * The catch-all route has no screen of its own, so its refusal cannot be
 * a panel: a pathname the bundle does not serve has no renderer on either side. The shell shows it
 * too when it cannot say which app is behind (`route-unavailable`). This replaces expo-router's Unmatched there, which says "Unmatched
 * Route" and offers a sitemap link that means nothing to someone holding a stale app.
 *
 * `replace` and not `push`: this screen is a dead end, so leaving it must not leave it behind to
 * come back to.
 *
 * Through `hostStackHostRoute` rather than a template: an id carrying `/` builds a two-segment
 * pathname, and `/h/a/b` is caught by the very route that rendered this, with `hostId` now `a`.
 *
 * An absent id has no host route to return to. `firstParam` answers `''`, and `/h/` matches no
 * screen at all — measured with expo-router's own matcher, it resolves to the `h` layout with no
 * child — so the way out is the app root, which is where `ProtocolBlockScreen` sends the same
 * gesture from the same position. The label follows the target rather than outliving it.
 *
 * `useRouteHandoff` and not `useRouter`: the page renders this screen too, through the catch-all's
 * `.web.tsx` sibling, and there a bare replace navigates inside the WebView to a route the page
 * does not carry instead of leaving it. The seam posts the target to the shell.
 */
export function PageRouteUnavailableScreen({
  hostId,
  hostName,
  message = 'This desktop does not offer this workspace screen yet.'
}: {
  hostId: string
  /** The desktop's name for the bar, when the caller has it. */
  hostName?: string
  message?: string
}) {
  const router = useRouteHandoff()
  const target = hostId === '' ? '/' : hostStackHostRoute(hostId)
  const label = hostId === '' ? 'Back to desktops' : 'Back to workspaces'
  const leave = () => router.replace(target)
  return (
    <ShellStateFrame
      title={hostName}
      onBack={leave}
      backAccessibilityLabel={label}
      testID="mobile-web-page-route-unavailable"
    >
      <ShellStateMessage
        icon={Compass}
        title="Not available here"
        message={message}
        primary={{ label, onPress: leave }}
      />
    </ShellStateFrame>
  )
}
