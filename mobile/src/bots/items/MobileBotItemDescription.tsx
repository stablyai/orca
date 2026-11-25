import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { MobileMarkdown } from '../../components/markdown/MobileMarkdown'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { INLINE_TEXT_SELECTION } from '../../platform/text-selection/inline-text-selection'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

const DESCRIPTION_LINES_HEIGHT = 3 * 20

/** The description's first three lines, then Show more; Markdown, as the desktop draws it. */
export function MobileBotItemDescription({ text }: { text: string }) {
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(0)
  const clamps = height > DESCRIPTION_LINES_HEIGHT + 4
  return (
    <View style={styles.description}>
      <View style={!open && clamps ? styles.clamped : undefined}>
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <MobileMarkdown content={text} rangeSelectable={INLINE_TEXT_SELECTION} />
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

const styles = themedStyleSheet(() => ({
  description: { marginTop: spacing.xs, gap: spacing.xs },
  clamped: { maxHeight: DESCRIPTION_LINES_HEIGHT, overflow: 'hidden' },
  showMore: { fontSize: 13, fontWeight: '600', color: colors.textPrimary }
}))
