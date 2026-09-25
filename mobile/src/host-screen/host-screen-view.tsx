import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { hostScreenStyles as styles } from './host-screen-styles'
import { HostScreenHeader } from './host-screen-header'
import { HostScreenOverlays } from './host-screen-overlays'
import { HostWorkspaceList } from './host-workspace-list'
import type { HostScreenController } from './use-host-screen-controller'
import { useHorizontalEdgePadding } from '../layout/screen-edge-padding'

export function HostScreenView({ controller }: { controller: HostScreenController }) {
  const horizontalPadding = useHorizontalEdgePadding()
  if (controller.state.error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{controller.state.error}</Text>
      </View>
    )
  }

  return (
    <SafeAreaView style={[styles.container, horizontalPadding]} edges={['top']}>
      <HostScreenHeader controller={controller} />
      <HostWorkspaceList controller={controller} />
      <HostScreenOverlays controller={controller} />
    </SafeAreaView>
  )
}
