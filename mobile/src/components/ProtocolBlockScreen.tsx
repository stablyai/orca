import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { CompatVerdict } from '../transport/protocol-compat'
import { MOBILE_PROTOCOL_VERSION } from '../transport/protocol-version'

const RELEASES_URL = 'https://github.com/stablyai/orca/releases'

type Props = {
  verdict: Extract<CompatVerdict, { kind: 'blocked' }>
}

export function ProtocolBlockScreen({ verdict }: Props) {
  const isMobileTooOld = verdict.reason === 'mobile-too-old'

  const title = isMobileTooOld ? 'Update Orca Mobile' : 'Update Orca desktop'
  const body = isMobileTooOld
    ? `The Orca desktop on this host requires Orca Mobile v${verdict.requiredMobileVersion ?? '?'}+. You have v${MOBILE_PROTOCOL_VERSION}.\n\nUpdate Orca Mobile from the App Store to continue.`
    : `Orca Mobile requires Orca desktop v${verdict.requiredDesktopVersion ?? '?'}+ to use this host. The desktop is reporting v${verdict.desktopVersion}.`

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
        {/* Why: only desktop side has a deep-link target today —
            App Store ID isn't published yet, so mobile-too-old is text-only. */}
        {!isMobileTooOld ? (
          <Pressable
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
            onPress={() => {
              void Linking.openURL(RELEASES_URL)
            }}
          >
            <Text style={styles.primaryButtonText}>Open GitHub Releases</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={() => {
            // Why: route back to the host list so the user can pair a
            // different host instead of getting trapped on this screen.
            router.replace('/')
          }}
        >
          <Text style={styles.secondaryButtonText}>Pair a different host</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg
  },
  card: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  title: {
    fontSize: typography.titleSize,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.sm
  },
  body: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    lineHeight: 20,
    marginBottom: spacing.lg
  },
  primaryButton: {
    backgroundColor: colors.textPrimary,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button,
    alignItems: 'center',
    marginBottom: spacing.sm
  },
  primaryButtonText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.bgBase
  },
  secondaryButton: {
    backgroundColor: colors.bgRaised,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button,
    alignItems: 'center'
  },
  secondaryButtonText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  pressed: {
    opacity: 0.7
  }
})
