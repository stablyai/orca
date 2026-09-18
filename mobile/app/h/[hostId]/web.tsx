import { useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { Redirect, useLocalSearchParams } from 'expo-router'
import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'
import { loadMobileWebShellEnabled } from '../../../src/storage/preferences'
import { colors } from '../../../src/theme/mobile-theme'

/**
 * The hybrid shell route, dark behind a development-only flag.
 *
 * The only caller of `loadMobileWebShellEnabled`. With the flag off — which is every store build,
 * since the only writer is the `__DEV__` Troubleshoot toggle — this redirects and the screen is
 * never constructed, so nothing is fetched, written or swept. It sits under `app/h/[hostId]` so
 * `HostProtocolGate` in that group's layout still owns the `desktop-too-old` wall above it.
 *
 * Reachable by deep link and from the developer row only; no screen links here.
 */
export default function MobileWebShellRoute() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let stale = false
    void loadMobileWebShellEnabled().then((value) => {
      if (!stale) {
        setEnabled(value)
      }
    })
    return () => {
      stale = true
    }
  }, [])

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
  return <MobileWebShellScreen hostId={hostId} />
}

const styles = StyleSheet.create({
  pending: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase
  }
})
