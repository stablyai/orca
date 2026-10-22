import { MobileSessionSurface } from './MobileSessionSurface'
import { useMobileSessionController } from './use-mobile-session-controller'
import { ActivityIndicator, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'

/**
 * The session screen as a component rather than a route module: the page's route file mounts it, and
 * the native route file, which mounts the shell, cannot be imported by the page. Its params are read
 * below this file, by the controller's foundation hook and the notification pane hook.
 */
export function MobileSessionRouteScreen() {
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
          <Text style={styles.emptyText}>Opening workspace</Text>
        </View>
      </View>
    )
  }
  return <MobileSessionSurface controller={controller} />
}
