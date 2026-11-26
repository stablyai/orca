import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { pressedStyle } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { queuedMessageStyles } from './mobile-native-chat-queued-message-styles'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'

// A clipped message opens in place on tap, inside the queue's own capped scroller.
export function MobileQueuedCardText({
  text,
  lines,
  expanded,
  onToggle
}: {
  text: string
  /** Lines shown before the ellipsis. */
  lines: number
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
      onTextLayout={(event) => setClipped(event.nativeEvent.lines.length > lines)}
    >
      {text}
    </Text>
  )
  const shown = (
    <Text style={queuedMessageStyles.bodyText} numberOfLines={expanded ? undefined : lines}>
      {text}
    </Text>
  )
  return (
    <View style={styles.probeBounds}>
      {measure}
      {clipped || expanded ? (
        <Pressable
          style={({ pressed }) => pressed && pressedStyle}
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
          {shown}
        </Pressable>
      ) : (
        shown
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  // Clip the full-text probe so it cannot stretch the queue's scroll range.
  probeBounds: {
    overflow: 'hidden'
  },
  measure: {
    position: 'absolute',
    left: 0,
    right: 0,
    opacity: 0
  }
}))
