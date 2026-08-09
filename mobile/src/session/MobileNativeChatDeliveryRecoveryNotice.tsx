import { Pressable, Text, View } from 'react-native'
import { AlertTriangle } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'

export function MobileNativeChatDeliveryRecoveryNotice({
  onShowTerminal
}: {
  onShowTerminal?: () => void
}): React.JSX.Element {
  return (
    <View
      style={styles.deliveryRecovery}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <View style={styles.deliveryRecoveryHeader}>
        <View style={styles.deliveryRecoveryIcon}>
          <AlertTriangle size={16} color={colors.textMuted} strokeWidth={2} />
        </View>
        <View style={styles.deliveryRecoveryCopy}>
          <Text style={styles.deliveryRecoveryTitle}>Message wasn’t sent</Text>
          <Text style={styles.deliveryRecoveryDescription}>
            The terminal may be waiting for input. Your message is still in the composer.
          </Text>
        </View>
      </View>
      <Pressable
        style={({ pressed }) => [styles.deliveryRecoveryButton, pressed && styles.pressed]}
        onPress={onShowTerminal}
        accessibilityRole="button"
      >
        <Text style={styles.deliveryRecoveryButtonText}>Show terminal</Text>
      </Pressable>
    </View>
  )
}
