import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { MobileNativeChatMarkdown } from '../../session/native-chat/transcript/message-content/MobileNativeChatMarkdown'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { INLINE_TEXT_SELECTION } from '../../platform/text-selection/inline-text-selection'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'

// Body text at 15/20: the shared Markdown base is 13/21, so scale it up and close its lines to 20.
const DESCRIPTION_LINE_HEIGHT = 20
const DESCRIPTION_TEXT_SCALE = 15 / 13
const DESCRIPTION_LINE_SPACING = DESCRIPTION_LINE_HEIGHT / (21 * DESCRIPTION_TEXT_SCALE)
const DESCRIPTION_LINES_HEIGHT = 3 * DESCRIPTION_LINE_HEIGHT

/** The description's first three lines, then Show more; Markdown, as the desktop draws it, in the
 *  secondary text color so the title leads. */
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
          <MobileNativeChatMarkdown
            content={text}
            rangeSelectable={INLINE_TEXT_SELECTION}
            textScale={DESCRIPTION_TEXT_SCALE}
            lineSpacing={DESCRIPTION_LINE_SPACING}
            tone="quiet"
          />
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
  description: { marginTop: 6, gap: spacing.xs },
  clamped: { maxHeight: DESCRIPTION_LINES_HEIGHT, overflow: 'hidden' },
  showMore: { fontSize: 13, fontWeight: '600', color: colors.textSecondary }
}))
