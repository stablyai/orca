import { Pressable, Text } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { authFailedBannerStyles as styles } from './auth-failed-banner-styles'

/**
 * What the banner offers once authentication has failed: reconnect, re-pair, or drop the pairing.
 *
 * Its own file because its `.web` sibling offers Re-pair alone: the page hands `/pair-scan` to the
 * shell, but its `forceReconnect` is null (`client-context.web.tsx`) and removal refuses
 * (`page-host-removal-refusal.ts`).
 */
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
