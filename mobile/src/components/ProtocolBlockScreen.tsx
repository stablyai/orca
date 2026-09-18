import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { CompatVerdict } from '../transport/protocol-compat'
import type { MobileWebBundleCompatVerdict } from '../transport/mobile-web-bundle-compat'

const RELEASES_URL = 'https://github.com/stablyai/orca/releases'
const IOS_APP_STORE_URL = 'itms-apps://apps.apple.com/app/orca-ide/id6766130217'

/** Every wall this screen renders: the protocol one and the bundle one. Both are terminal — there
 *  is no native workspace to fall back to, so the only way out is updating one of the two apps. */
export type BlockedVerdict =
  | Extract<CompatVerdict, { kind: 'blocked' }>
  | Extract<MobileWebBundleCompatVerdict, { kind: 'blocked' }>

type Props = {
  verdict: BlockedVerdict
}

const DESKTOP_TOO_OLD_BODY =
  'This paired desktop app is too old for your current Orca Mobile app. Update Orca on your computer, then try this host again.'

/** Which of the two apps the user has to update. Drives the copy and the store link together, so a
 *  new reason cannot ship a mobile title over a desktop button. */
function updateSide(verdict: BlockedVerdict): 'mobile' | 'desktop' {
  switch (verdict.reason) {
    case 'mobile-too-old':
    case 'bundle-shell-too-old':
      return 'mobile'
    case 'desktop-too-old':
    case 'bundle-unavailable':
      return 'desktop'
    case 'bundle-incompatible':
      return verdict.side
  }
}

function blockBody(verdict: BlockedVerdict, storeName: string): string {
  if (verdict.reason === 'mobile-too-old') {
    return `This desktop needs a newer Orca Mobile app. Update Orca Mobile from ${storeName}, then try this host again.`
  }
  if (verdict.reason === 'bundle-unavailable') {
    return 'This paired desktop app does not include the mobile workspace yet. Update Orca on your computer, then try this host again.'
  }
  // Both bundle walls the phone owns read the same way: this desktop's workspace outran the shell.
  if (updateSide(verdict) === 'mobile') {
    return `This desktop's mobile workspace needs a newer Orca Mobile app. Update Orca Mobile from ${storeName}, then try this host again.`
  }
  return DESKTOP_TOO_OLD_BODY
}

export function ProtocolBlockScreen({ verdict }: Props) {
  const updatesMobile = updateSide(verdict) === 'mobile'
  // Why: Android APKs ship through GitHub Releases until a Play Store listing exists.
  const mobileUpdateTarget =
    Platform.OS === 'ios'
      ? { label: 'Open App Store', url: IOS_APP_STORE_URL, storeName: 'the App Store' }
      : { label: 'Open GitHub Releases', url: RELEASES_URL, storeName: 'GitHub Releases' }
  const primaryAction = updatesMobile
    ? { label: mobileUpdateTarget.label, url: mobileUpdateTarget.url }
    : { label: 'Open GitHub Releases', url: RELEASES_URL }

  const title = updatesMobile ? 'Update Orca Mobile' : 'Update Orca on your computer'
  const body = blockBody(verdict, mobileUpdateTarget.storeName)
  const recoveryNote =
    'Already updated? Go back to Hosts and refresh the connection. If this message stays, remove this host and pair it again.'

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
          onPress={() => {
            void Linking.openURL(primaryAction.url)
          }}
        >
          <Text style={styles.primaryButtonText}>{primaryAction.label}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={() => {
            // Why: route back to the host list so the user can pair a
            // different host instead of getting trapped on this screen.
            router.replace('/')
          }}
        >
          <Text style={styles.secondaryButtonText}>Back to hosts</Text>
        </Pressable>
        <Text style={styles.recoveryNote}>{recoveryNote}</Text>
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
  recoveryNote: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 17,
    marginTop: spacing.md
  },
  pressed: {
    opacity: 0.7
  }
})
