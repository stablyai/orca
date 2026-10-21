import { Pressable, Text } from 'react-native'
import { authFailedBannerStyles as styles } from './auth-failed-banner-styles'

/**
 * The page offers Re-pair alone: its push of `/pair-scan` is handed to the shell
 * (`route-handoff.web.ts`), which opens the native scan screen. Retry and Remove are inert here —
 * `forceReconnect` is null (`client-context.web.tsx`) and removal refuses
 * (`page-host-removal-refusal.ts`) — so a line names the app for those two instead.
 */
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
