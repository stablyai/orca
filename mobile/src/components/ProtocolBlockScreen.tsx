import { openExternalLink } from '../platform/external-link'
import { useRouteHandoff } from '../navigation/route-handoff'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
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

/** What clears the wall. `refresh-bundle` is the one that no store can: the cached workspace is
 *  older than this host's client floor, so a download fixes it and an app update does not. */
type BlockRemedy = 'update-mobile' | 'update-desktop' | 'refresh-bundle'

function blockRemedy(verdict: BlockedVerdict): BlockRemedy {
  switch (verdict.reason) {
    case 'mobile-too-old':
    case 'bundle-shell-too-old':
      return 'update-mobile'
    case 'desktop-too-old':
    case 'bundle-unavailable':
      return 'update-desktop'
    case 'bundle-incompatible':
      return verdict.side === 'desktop' ? 'update-desktop' : 'refresh-bundle'
  }
}

function blockTitle(remedy: BlockRemedy): string {
  switch (remedy) {
    case 'update-mobile':
      return 'Update Orca Mobile'
    case 'update-desktop':
      return 'Update Orca on your computer'
    case 'refresh-bundle':
      return 'Refresh the mobile workspace'
  }
}

function blockBody(verdict: BlockedVerdict, remedy: BlockRemedy, storeName: string): string {
  if (remedy === 'refresh-bundle') {
    return 'The workspace cached for this host is older than the desktop expects. Reconnect to this host to download the current one.'
  }
  if (verdict.reason === 'mobile-too-old') {
    return `This desktop needs a newer Orca Mobile app. Update Orca Mobile from ${storeName}, then try this host again.`
  }
  if (verdict.reason === 'bundle-unavailable') {
    return 'This paired desktop app does not include the mobile workspace yet. Update Orca on your computer, then try this host again.'
  }
  if (remedy === 'update-mobile') {
    return `This desktop's mobile workspace needs a newer Orca Mobile app. Update Orca Mobile from ${storeName}, then try this host again.`
  }
  return DESKTOP_TOO_OLD_BODY
}

export function ProtocolBlockScreen({ verdict }: Props) {
  const router = useRouteHandoff()
  const remedy = blockRemedy(verdict)
  // Why: Android APKs ship through GitHub Releases until a Play Store listing exists.
  const mobileUpdateTarget =
    Platform.OS === 'ios'
      ? { label: 'Open App Store', url: IOS_APP_STORE_URL, storeName: 'the App Store' }
      : { label: 'Open GitHub Releases', url: RELEASES_URL, storeName: 'GitHub Releases' }
  // No download to offer when the fix is a refetch: reconnecting is what this screen leaves you to do.
  const primaryAction =
    remedy === 'refresh-bundle'
      ? null
      : remedy === 'update-mobile'
        ? { label: mobileUpdateTarget.label, url: mobileUpdateTarget.url }
        : { label: 'Open GitHub Releases', url: RELEASES_URL }

  const title = blockTitle(remedy)
  const body = blockBody(verdict, remedy, mobileUpdateTarget.storeName)
  const recoveryNote =
    remedy === 'refresh-bundle'
      ? 'If this message stays, remove this host and pair it again.'
      : 'Already updated? Go back to Hosts and refresh the connection. If this message stays, remove this host and pair it again.'

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
        {primaryAction ? (
          <Pressable
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
            onPress={() => {
              // The seam: this screen is in the tasks page closure, where react-native's `openURL`
              // calls a `window.open` both shells refuse and resolves anyway.
              openExternalLink(primaryAction.url)
            }}
          >
            <Text style={styles.primaryButtonText}>{primaryAction.label}</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={() => {
            // The handoff, not expo-router's singleton: `/` is the phone's home screen and the
            // page does not carry it, so inside the shell a singleton replace renders the root
            // route in the WebView rather than leaving it. This posts the target to the shell.
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
