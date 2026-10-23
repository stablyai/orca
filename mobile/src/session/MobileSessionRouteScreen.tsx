import { View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { MobileSessionSurface } from './MobileSessionSurface'
import { useMobileSessionController } from './use-mobile-session-controller'
import { NavBar } from '../components/ui/NavBar'
import { StateView } from '../components/ui/StateView'
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
    // Why: a slow boot keeps its way out; the bar matches the one the session opens into.
    return (
      <View style={styles.container}>
        <SafeAreaView edges={['top']}>
          <NavBar
            title={controller.worktreeName || 'Workspace'}
            onBack={controller.requestLeaveSession}
            backAccessibilityLabel="Back to worktrees"
          />
        </SafeAreaView>
        <StateView loading title="Opening workspace…" />
      </View>
    )
  }
  return <MobileSessionSurface controller={controller} />
}
