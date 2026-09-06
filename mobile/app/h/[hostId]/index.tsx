import { Text, View } from 'react-native'
import { WorkspaceDetailPlaceholder } from '../../../src/components/WorkspaceDetailPlaceholder'
import { HostScreenView } from '../../../src/host-screen/host-screen-view'
import {
  useHybridHostScreenController,
  type HybridHostScreenProps
} from '../../../src/host-screen/use-hybrid-host-screen-controller'
import { useResponsiveLayout } from '../../../src/layout/responsive-layout'
import { hostScreenStyles as styles } from '../../../src/host-screen/host-screen-styles'

export function HostScreen(props: HybridHostScreenProps = {}) {
  const controller = useHybridHostScreenController(props)
  if (controller.state.error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{controller.state.error}</Text>
      </View>
    )
  }
  return <HostScreenView controller={controller} />
}

export default function HostWorktreeRoute() {
  const { isWideLayout } = useResponsiveLayout()
  return isWideLayout ? <WorkspaceDetailPlaceholder /> : <HostScreen />
}
