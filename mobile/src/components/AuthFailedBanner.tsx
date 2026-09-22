import { View, Text } from 'react-native'
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
    <View style={styles.banner}>
      <Text style={styles.text}>
        Authentication failed — try reconnecting first; if it keeps failing, re-pair from desktop.
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
  )
}
