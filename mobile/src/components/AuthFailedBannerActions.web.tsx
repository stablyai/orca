import { Text } from 'react-native'
import { Button } from './ui/Button'
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
      <Button label="Re-pair" size="compact" onPress={onRepair} />
      <Text style={styles.note}>Reconnect or remove this desktop from the Orca app.</Text>
    </>
  )
}
