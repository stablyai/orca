import { Platform, View } from 'react-native'
import { CircleAlert, WifiOff } from 'lucide-react-native'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { useMobileUpdateLink } from '../../components/host-connection/ProtocolBlockScreen'
import { useHostProfile } from '../../host-catalog/use-host-profile'
import { useHostDisplay } from '../../host-descriptors/use-host-display'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { hostStackHostRoute } from '../../navigation/host-stack-navigation'
import { useRouteHandoff } from '../../navigation/route-handoff'
import { openExternalLink } from '../../platform/external-links/external-link'
import { colors } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

// Catch-all routes have no renderer on either side; show an escape screen instead of Expo’s unusable sitemap.
// Replace this dead end via route handoff so page navigation reaches the shell. Encode host ids with hostStackHostRoute; missing ids return to app root because /h/ has no child screen.
export function PageRouteUnavailableScreen({
  hostId,
  reason = 'update'
}: {
  hostId: string
  /** `update`: neither this app nor the host's page has the screen; either side may be behind. */
  reason?: 'update' | 'unreachable-server'
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  const update = useMobileUpdateLink()
  const profile = useHostProfile(hostId)
  const title = useHostDisplay(profile).title
  // Until its profile reads (or for an unknown id) there is no name to say.
  const host = profile ? title : null
  const back = {
    label: t('common.back', 'Back'),
    onPress: () => router.replace(hostId === '' ? '/' : hostStackHostRoute(hostId))
  }
  return (
    <View style={styles.root} testID="mobile-web-page-route-unavailable">
      {reason === 'unreachable-server' ? (
        <MobileStateView
          icon={WifiOff}
          title={t('webShell.pageRouteUnavailable.serverTitle', 'Can’t reach this server')}
          message={
            host
              ? t(
                  'webShell.pageRouteUnavailable.serverMessage',
                  'Your phone can’t reach this workspace’s server through {{host}}.',
                  { host }
                )
              : null
          }
          action={back}
        />
      ) : (
        <MobileStateView
          icon={CircleAlert}
          title={t('webShell.pageRouteUnavailable.updateTitle', 'Update Orca')}
          message={
            host
              ? t(
                  'webShell.pageRouteUnavailable.updateMessage',
                  'This screen needs a newer Orca on your phone or on {{host}}.',
                  { host }
                )
              : t(
                  'webShell.pageRouteUnavailable.updateMessageNoHost',
                  'This screen needs a newer Orca.'
                )
          }
          // A page can't tell which store installed the app (Play forbids the others), so only the
          // shell offers its link.
          {...(Platform.OS === 'web'
            ? { action: back }
            : {
                action: { label: update.label, onPress: () => openExternalLink(update.url) },
                secondaryAction: back
              })}
        />
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  root: { flex: 1, backgroundColor: colors.bgBase }
}))
