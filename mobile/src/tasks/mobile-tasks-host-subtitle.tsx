import { StyleSheet, Text } from 'react-native'
import { hostScreenStyles } from '../host-screen/host-screen-styles'
import { useHostProfile } from '../transport/use-host-profile'
import { useHostDisplay } from '../transport/use-host-display'
import { useMobileColorScheme } from './mobile-tasks-dependencies'

export function MobileTasksHostSubtitle({ hostId }: { hostId: string }) {
  useMobileColorScheme()
  const host = useHostProfile(hostId)
  const title = useHostDisplay(host).title
  // Reserve the line before load to prevent a title jump; unknown hosts stay blank instead of showing generic Host.
  return (
    <Text
      style={[hostScreenStyles.hostPlatformText, styles.reserved]}
      numberOfLines={1}
      testID="mobile-tasks-host-subtitle"
    >
      {host ? title : ''}
    </Text>
  )
}

const styles = StyleSheet.create({
  reserved: { minHeight: hostScreenStyles.hostPlatformText.lineHeight }
})
