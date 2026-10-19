import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, typography } from '../theme/mobile-theme'
import { queuedMessageStyles } from './mobile-native-chat-queued-message-styles'

/** Two lines, opening on tap when it clips: a card can hold another agent's message the person
 *  never read, and Steer or Delete must not be a blind choice. Opened, the queue's own capped list
 *  scrolls through a long one: a second scroll box inside it would be taller than its viewport. */
export function MobileQueuedCardText({
  text,
  expanded,
  onToggle
}: {
  text: string
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const [clipped, setClipped] = useState(false)
  // The whole text laid out unseen at the card's width: more than two lines is what clips.
  const measure = (
    <Text
      style={[queuedMessageStyles.bodyText, styles.measure]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onTextLayout={(event) => setClipped(event.nativeEvent.lines.length > 2)}
    >
      {text}
    </Text>
  )
  if (!clipped && !expanded) {
    return (
      <View>
        {measure}
        <Text style={queuedMessageStyles.bodyText} numberOfLines={2}>
          {text}
        </Text>
      </View>
    )
  }
  const toggle = (
    <Pressable
      testID="queued-card-text"
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityHint={expanded ? 'Shows less of the message' : 'Shows the whole message'}
      onPress={onToggle}
    >
      {expanded ? null : (
        <Text style={queuedMessageStyles.bodyText} numberOfLines={2}>
          {text}
        </Text>
      )}
      <Text style={styles.caption}>{expanded ? 'Show less' : 'Show more'}</Text>
    </Pressable>
  )
  return (
    <View>
      {expanded ? null : measure}
      {toggle}
    </View>
  )
}

const styles = StyleSheet.create({
  measure: {
    position: 'absolute',
    left: 0,
    right: 0,
    opacity: 0
  },
  caption: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  }
})
