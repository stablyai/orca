import { View, Text } from 'react-native'
import { AuthFailedBannerActions } from './AuthFailedBannerActions'
import { authFailedBannerStyles as styles } from './auth-failed-banner-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Transient auth failure may leave desktop pairing valid (#5200); offer fresh-client/handshake Retry before disruptive re-pair.
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
  useMobileColorScheme()
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
