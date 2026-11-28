import { MobileSessionSurface } from './MobileSessionSurface'
import { useMobileSessionController } from './use-mobile-session-controller'
import { ActivityIndicator, Text, View } from 'react-native'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { stylesSheet } from './mobile-session-styles'
import { useThemedStyles } from '../theme/themed-styles'

// Keep the screen importable by the page; native route modules mount the shell.
export function MobileSessionRouteScreen() {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const controller = useMobileSessionController()
  // Readiness stays true on refocus so returning from Settings preserves mounted panes.
  if (
    !controller.terminalPreferencesReady ||
    !controller.accessoryPreferencesReady ||
    !controller.nativeChatController.sessionViewReady
  ) {
    return (
      <View style={styles.container}>
        <View style={styles.emptyState}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={styles.emptyText}>
            {t('session.routeScreen.openingWorkspace', 'Opening workspace')}
          </Text>
        </View>
      </View>
    )
  }
  return <MobileSessionSurface controller={controller} />
}
