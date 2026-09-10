import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { RefreshCw } from 'lucide-react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors } from '../theme/mobile-theme'
import { mobileMaestroScreenStyles as styles } from './mobile-maestro-screen-styles'

export function MobileMaestroLoading() {
  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <View style={styles.center}>
        <ActivityIndicator color={colors.textSecondary} />
        <Text style={styles.centerText}>Loading workspace Canvas…</Text>
      </View>
    </SafeAreaView>
  )
}

type MobileMaestroUnavailableProps = {
  reason: string
  onRetry: () => void
}

export function MobileMaestroUnavailable({ reason, onRetry }: MobileMaestroUnavailableProps) {
  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Maestro unavailable</Text>
        <Text style={styles.centerText}>{reason}</Text>
        <Pressable style={styles.retry} onPress={onRetry}>
          <RefreshCw size={16} color={colors.textPrimary} />
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  )
}
