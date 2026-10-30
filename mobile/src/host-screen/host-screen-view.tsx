import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { hostScreenStyles as styles } from './host-screen-styles'
import { HostScreenHeader } from './host-screen-header'
import { HostScreenOverlays } from './host-screen-overlays'
import { HostWorkspaceList } from './host-workspace-list'
import type { HostScreenController } from './use-host-screen-controller'

export function HostScreenView({ controller }: { controller: HostScreenController }) {
  useMobileColorScheme()
  if (controller.state.error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{controller.state.error}</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.topChromeSafeArea} edges={['top']}>
        <HostScreenHeader controller={controller} />
      </SafeAreaView>
      <HostWorkspaceList controller={controller} />
      <HostScreenOverlays controller={controller} />
    </View>
  )
}
