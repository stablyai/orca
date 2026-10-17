import { useMobileTheme } from '../theme/use-mobile-theme'
import { Text, View } from 'react-native'
import { MobileScreenFrame } from '../layout/MobileScreenFrame'
import { hostScreenStyles as styles } from './host-screen-styles'
import { HostScreenHeader } from './host-screen-header'
import { HostScreenOverlays } from './host-screen-overlays'
import { HostWorkspaceList } from './host-workspace-list'
import type { HostScreenController } from './use-host-screen-controller'

export function HostScreenView({ controller }: { controller: HostScreenController }) {
  useMobileTheme()

  if (controller.state.error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{controller.state.error}</Text>
      </View>
    )
  }

  return (
    <MobileScreenFrame header={<HostScreenHeader controller={controller} />}>
      <HostWorkspaceList controller={controller} />
      <HostScreenOverlays controller={controller} />
    </MobileScreenFrame>
  )
}
