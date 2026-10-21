import { Platform, Pressable, Text } from 'react-native'
import type { SessionTitleCard } from './use-session-title-card'
import { StatusDot } from '../components/StatusDot'
import type { ConnectionState } from '../transport/types'
import { styles } from './mobile-session-styles'

/** The session's title and status line. A tap opens a card with the full name, where it lives
 *  and its host, as desktop's tab card does, because a sideways phone cuts the title short. */
export function MobileSessionTitleBlock({
  title,
  connState,
  details,
  meta,
  showConnectionRetry,
  onRetry
}: {
  title: string
  connState: ConnectionState
  details: SessionTitleCard
  meta: string
  showConnectionRetry: boolean
  onRetry: () => void
}): React.JSX.Element {
  return (
    <Pressable
      style={[styles.sessionTitleBlock, details.besideTabs && styles.sessionTitleBlockBesideTabs]}
      ref={details.openerRef}
      onLayout={details.onAnchorLayout}
      onPress={details.toggle}
      aria-expanded={details.requestedOpen}
      accessibilityRole="button"
      accessibilityHint="Shows the full workspace name and where it is"
    >
      <Text
        ref={details.titleRef}
        onLayout={details.onAnchorLayout}
        onPress={Platform.OS === 'web' ? details.toggle : undefined}
        style={styles.sessionTitle}
        numberOfLines={1}
      >
        {title}
      </Text>
      <Pressable
        style={styles.sessionMetaRow}
        disabled={!showConnectionRetry}
        onPress={onRetry}
        accessibilityRole={showConnectionRetry ? 'button' : undefined}
        accessibilityLabel={showConnectionRetry ? 'Reconnect to desktop' : undefined}
      >
        <StatusDot state={connState} />
        <Text style={styles.sessionMetaText} numberOfLines={1}>
          {meta}
        </Text>
      </Pressable>
    </Pressable>
  )
}
