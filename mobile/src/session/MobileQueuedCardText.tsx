import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { colors, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { queuedMessageStyles } from './native-chat/input/mobile-native-chat-queued-message-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

// Expand clipped queued text before Steer/Delete; use the queue’s capped scroller rather than nesting another scroll box.
export function MobileQueuedCardText({
  text,
  expanded,
  onToggle
}: {
  text: string
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [clipped, setClipped] = useState(false)
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
      accessibilityHint={
        expanded
          ? t('session.queuedCardText.showLessHint', 'Shows less of the message')
          : t('session.queuedCardText.showMoreHint', 'Shows the whole message')
      }
      onPress={onToggle}
    >
      {expanded ? null : (
        <Text style={queuedMessageStyles.bodyText} numberOfLines={2}>
          {text}
        </Text>
      )}
      <Text style={styles.caption}>
        {expanded
          ? t('session.queuedCardText.showLess', 'Show less')
          : t('session.queuedCardText.showMore', 'Show more')}
      </Text>
    </Pressable>
  )
  return (
    <View>
      {expanded ? null : measure}
      {toggle}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
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
}))
