import { Pressable, StyleSheet, Text, View } from 'react-native'
import { hostStackHostRoute } from '../navigation/host-stack-navigation'
import { useRouteHandoff } from '../navigation/route-handoff'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

// Catch-all routes have no renderer on either side; show an escape screen instead of Expo’s unusable sitemap.
// Replace this dead end via route handoff so page navigation reaches the shell. Encode host ids with hostStackHostRoute; missing ids return to app root because /h/ has no child screen.
export function PageRouteUnavailableScreen({
  hostId,
  message = 'This workspace screen is not available on this host.'
}: {
  hostId: string
  message?: string
}) {
  const router = useRouteHandoff()
  const target = hostId === '' ? '/' : hostStackHostRoute(hostId)
  const label = hostId === '' ? 'Back to hosts' : 'Back to workspaces'
  return (
    <View style={styles.root} testID="mobile-web-page-route-unavailable">
      <Text style={styles.message}>{message}</Text>
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
