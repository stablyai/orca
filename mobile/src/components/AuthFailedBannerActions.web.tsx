import { Pressable, Text } from 'react-native'
import { authFailedBannerStyles as styles } from './auth-failed-banner-styles'

// Offer shell-routed /pair-scan only; web forceReconnect is null and page-host-removal-refusal rejects Remove, so direct users to app for both.
export function AuthFailedBannerActions({
  onRepair
}: {
  canRetry: boolean
  onRetry: () => void
  onRepair: () => void
  onRemove: () => void
}) {
  return (
    <>
      <Pressable style={styles.action} onPress={onRepair}>
        <Text style={styles.actionText}>Re-pair</Text>
      </Pressable>
      <Text style={styles.note}>Reconnect or remove this host from the Orca app.</Text>
    </>
  )
}
