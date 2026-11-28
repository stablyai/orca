import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { MobileNativeChatMarkdown } from '../../session/native-chat/transcript/message-content/MobileNativeChatMarkdown'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { INLINE_TEXT_SELECTION } from '../../platform/text-selection/inline-text-selection'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'

const DESCRIPTION_LINES_HEIGHT = 3 * 20

/** The description's first three lines, then Show more; Markdown, as the desktop draws it. */
export function MobileBotItemDescription({ text }: { text: string }) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(0)
  const clamps = height > DESCRIPTION_LINES_HEIGHT + 4
  return (
    <View style={styles.description}>
      <View style={!open && clamps ? styles.clamped : undefined}>
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <MobileNativeChatMarkdown content={text} rangeSelectable={INLINE_TEXT_SELECTION} />
        </View>
      </View>
      {clamps ? (
        <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" hitSlop={6}>
          <Text style={styles.showMore}>
            {open
              ? t('bots.items.view.showLess', 'Show less')
              : t('bots.items.view.showMore', 'Show more')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  description: { marginTop: spacing.xs, gap: spacing.xs },
  clamped: { maxHeight: DESCRIPTION_LINES_HEIGHT, overflow: 'hidden' },
  showMore: { fontSize: 13, fontWeight: '600', color: colors.textPrimary }
}))
