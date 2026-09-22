import { Text } from 'react-native'
import { authFailedBannerStyles as styles } from './auth-failed-banner-styles'

/**
 * The page offers no control here, because it can honour none of the three.
 *
 * `forceReconnect` is `() => Promise.resolve()` on this document (`client-context.web.tsx`), the
 * page registers only routes under `app/h` so `/pair-scan` is not one of them, and removal refuses
 * (`page-host-removal-refusal.ts`). A line naming the app rather than nothing at all: a banner that
 * reports a failure and offers no way out reads as a dead end.
 */
export function AuthFailedBannerActions(_props: {
  canRetry: boolean
  onRetry: () => void
  onRepair: () => void
  onRemove: () => void
}) {
  return <Text style={styles.actionText}>Reconnect or re-pair from the Orca app.</Text>
}
