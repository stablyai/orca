import { View, Text } from 'react-native'
import { AlertCircle } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { AuthFailedBannerActions } from './AuthFailedBannerActions'
import { authFailedBannerStyles as styles } from './auth-failed-banner-styles'

// Why: auth-failed is no longer necessarily terminal (issue #5200) — a
// transient rejection can latch it even though the desktop still lists this
// device. Offer Retry (fresh client + handshake) ahead of the disruptive
// re-pair flow so the common transient case recovers without re-pairing.
export function AuthFailedBanner({
  canRetry,
  onRetry,
  onRepair,
  onRemove
}: {
  canRetry: boolean
  onRetry: () => void
  onRepair: () => void
  onRemove: () => void
}) {
  return (
    <View style={styles.frame}>
      <View style={styles.banner} accessibilityRole="alert">
        <AlertCircle size={18} color={colors.danger} strokeWidth={2.2} style={styles.icon} />
        <View style={styles.main}>
          <Text style={styles.title}>Authentication failed</Text>
          <Text style={styles.text}>
            Try reconnecting first. If it keeps failing, re-pair from the desktop.
          </Text>
          <View style={styles.actions}>
            <AuthFailedBannerActions
              canRetry={canRetry}
              onRetry={onRetry}
              onRepair={onRepair}
              onRemove={onRemove}
            />
          </View>
        </View>
      </View>
    </View>
  )
}
