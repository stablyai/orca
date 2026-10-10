import { Pressable, StyleSheet, Text, View } from 'react-native'
import { hostStackHostRoute } from '../navigation/host-stack-navigation'
import { useRouteHandoff } from '../navigation/route-handoff'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

/**
 * What a host-scoped pathname nothing can paint lands on.
 *
 * The catch-all route is the one switch with no native screen behind it, so its `fallback` cannot
 * be a panel: a pathname the bundle does not list, or lists needing a grant this app lacks, has no
 * renderer on either side. This replaces expo-router's Unmatched there, which says "Unmatched
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
export function PageRouteUnavailableScreen({ hostId }: { hostId: string }) {
  const router = useRouteHandoff()
  const target = hostId === '' ? '/' : hostStackHostRoute(hostId)
  const label = hostId === '' ? 'Back to hosts' : 'Back to workspaces'
  return (
    <View style={styles.root} testID="mobile-web-page-route-unavailable">
      <Text style={styles.message}>This workspace screen is not available on this host.</Text>
      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => router.replace(target)}
      >
        <Text style={styles.buttonLabel}>{label}</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg
  },
  message: {
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: spacing.lg
  },
  button: {
    backgroundColor: colors.bgRaised,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.button
  },
  buttonLabel: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  pressed: {
    opacity: 0.7
  }
})
