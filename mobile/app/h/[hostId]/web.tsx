import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { Redirect, useLocalSearchParams } from 'expo-router'
import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'
import { useMobileWebShellEnabled } from '../../../src/mobile-web-shell/use-mobile-web-shell-enabled'
import { colors } from '../../../src/theme/mobile-theme'

/**
 * The hybrid shell route, dark behind a development-only flag.
 *
 * One of the two callers of `useMobileWebShellEnabled`. With the flag off — which is every store build,
 * since the only writer is the `__DEV__` Troubleshoot toggle — this redirects and the screen is
 * never constructed, so nothing is fetched, written or swept. It sits under `app/h/[hostId]` so
 * `HostProtocolGate` in that group's layout still owns the `desktop-too-old` wall above it.
 *
 * Reachable by deep link and from the developer row only; no screen links here.
 */
export default function MobileWebShellRoute() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const enabled = useMobileWebShellEnabled()

  if (enabled === null) {
    // A redirect fired before the read settles would bounce a flag that is on, and a screen mounted
    // before it settles would fetch on a flag that is off. Neither, until it is known.
    return (
      <View style={styles.pending}>
        <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Checking host" />
      </View>
    )
  }
  if (!enabled || !hostId) {
    return <Redirect href={`/h/${hostId ?? ''}`} />
  }
  // The screen the page stands in for. The document is served at `/`, which matches no route in
  // the tree the page carries, so this is the only thing that tells it which one to open.
  //
  // The fallback is a redirect rather than the native screen: this route exists only to open the
  // page deliberately, so a bundle that does not list the worktree list has nothing to show here
  // and the host route is where the list actually lives.
  //
  // Encoded, not interpolated raw: `hostId` arrives decoded from the URL, so one carrying `?`, `#`
  // or whitespace would build a pathname the page refuses and never mount anything. The page
  // decodes it back when it matches `[hostId]`, so the screen it opens is the same one.
  return (
    <MobileWebShellScreen
      hostId={hostId}
      route={{ pathname: `/h/${encodeURIComponent(hostId)}` }}
      fallback={<Redirect href={`/h/${hostId}`} />}
    />
  )
}

const styles = StyleSheet.create({
  pending: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase
  }
})
