import { ActivityIndicator } from 'react-native'
import { HostRouteNoticeBanner } from '../components/HostRouteNoticeBanner'
import { colors } from '../theme/mobile-theme'
import { conversationCopy } from './conversation-copy'
import { conversationStyles as styles } from './conversation-styles'

export function ConversationHistoryLoadStatus({
  loading,
  failed,
  connected,
  onRefresh
}: {
  loading: boolean
  failed: boolean
  connected: boolean
  onRefresh: () => void
}) {
  const copy = conversationCopy()
  return (
    <>
      {failed ? (
        <HostRouteNoticeBanner
          message={copy.failed}
          action={connected ? { label: copy.refresh, onPress: onRefresh } : undefined}
        />
      ) : null}
      {loading ? (
        <ActivityIndicator
          style={styles.spinner}
          color={colors.textMuted}
          accessibilityLabel={copy.loading}
        />
      ) : null}
    </>
  )
}
