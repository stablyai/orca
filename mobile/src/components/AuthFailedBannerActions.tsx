import { Pressable, Text } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { authFailedBannerStyles as styles } from './auth-failed-banner-styles'

// Native offers reconnect/re-pair/remove; web sibling offers only shell-routed re-pair because reconnect is null and removal refuses.
export function AuthFailedBannerActions({
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
    <>
      {canRetry && (
        <Pressable style={styles.action} onPress={onRetry}>
          <Text style={styles.actionText}>Retry</Text>
        </Pressable>
      )}
      <Pressable style={styles.action} onPress={onRepair}>
        <Text style={styles.actionText}>Re-pair</Text>
      </Pressable>
      <Pressable style={styles.action} onPress={onRemove}>
        <Text style={[styles.actionText, { color: colors.statusRed }]}>Remove</Text>
      </Pressable>
    </>
  )
}
