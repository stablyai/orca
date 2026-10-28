import { useWallAppUpdate } from '../app-update/use-wall-app-update'
import { openExternalLink } from '../platform/external-link'
import { useRouteHandoff } from '../navigation/route-handoff'
import { Platform, Pressable, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { CompatVerdict } from '../transport/protocol-compat'
import type { MobileWebBundleCompatVerdict } from '../transport/mobile-web-bundle-compat'
import type { PageRouteRefusalVerdict } from '../mobile-web-shell/page-route-policy'

const RELEASES_URL = 'https://github.com/stablyai/orca/releases'
const IOS_APP_STORE_URL = 'itms-apps://apps.apple.com/app/orca-ide/id6766130217'

// Protocol/bundle/page-route walls are terminal: no native workspace fallback; update the relevant app or bundle.
export type BlockedVerdict =
  | Extract<CompatVerdict, { kind: 'blocked' }>
  | Extract<MobileWebBundleCompatVerdict, { kind: 'blocked' }>
  | PageRouteRefusalVerdict

type Props = {
  verdict: BlockedVerdict
}

const DESKTOP_TOO_OLD_BODY =
  'This paired desktop app is too old for your current Orca Mobile app. Update Orca on your computer, then try this host again.'

// refresh-bundle fixes cached workspace older than host floor; store app update cannot replace that cache.
type BlockRemedy = 'update-mobile' | 'update-desktop' | 'refresh-bundle'

function blockRemedy(verdict: BlockedVerdict): BlockRemedy {
  switch (verdict.reason) {
    case 'mobile-too-old':
    case 'bundle-shell-too-old':
    case 'page-route-grant-missing':
      return 'update-mobile'
    case 'desktop-too-old':
    case 'bundle-unavailable':
    case 'page-route-unlisted':
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
  if (remedy === 'update-mobile') {
    return `This desktop's mobile workspace needs a newer Orca Mobile app. Update Orca Mobile from ${storeName}, then try this host again.`
  }
  return DESKTOP_TOO_OLD_BODY
}

export function ProtocolBlockScreen({ verdict }: Props) {
  useMobileColorScheme()
  const router = useRouteHandoff()
  const mobileUpdate = useWallAppUpdate()
  const remedy = blockRemedy(verdict)
  // Why: Android APKs ship through GitHub Releases until a Play Store listing exists.
  const mobileUpdateTarget =
    Platform.OS === 'ios'
      ? { label: 'Open App Store', url: IOS_APP_STORE_URL, storeName: 'the App Store' }
      : { label: 'Open GitHub Releases', url: RELEASES_URL, storeName: 'GitHub Releases' }
  const mobileAction = mobileUpdate
    ? { label: `Get Orca ${mobileUpdate.version}`, url: mobileUpdate.url }
    : { label: mobileUpdateTarget.label, url: mobileUpdateTarget.url }
  // No download to offer when the fix is a refetch: reconnecting is what this screen leaves you to do.
  const primaryAction =
    remedy === 'refresh-bundle'
      ? null
      : remedy === 'update-mobile'
        ? mobileAction
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
              // Use external-link seam: page’s RN openURL calls window.open, which both shells refuse despite resolving.
              openExternalLink(primaryAction.url)
            }}
          >
            <Text style={styles.primaryButtonText}>{primaryAction.label}</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={() => {
            // Hand home replacement to shell; expo-router singleton inside page would render / in WebView instead of leaving it.
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

const styles = themedStyleSheet(() => ({
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
}))
