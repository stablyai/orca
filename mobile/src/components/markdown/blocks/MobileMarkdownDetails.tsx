import { useState, type ReactNode } from 'react'
import { Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { DisclosureChevron } from '../../list/DisclosureChevron'
import { stylesSheet } from '../mobile-markdown-styles'
import { pressedStyle } from '../../../theme/mobile-theme'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
import { useThemedStyles } from '../../../theme/themed-styles'

/** A `<details>` section: closed unless authored `open`, like desktop and GitHub. */
export function MobileMarkdownDetails({
  summary,
  open,
  summaryStyle,
  children
}: {
  summary: ReactNode
  open: boolean
  summaryStyle: StyleProp<TextStyle>
  children: ReactNode
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const [expanded, setExpanded] = useState(open)
  return (
    <View style={styles.details}>
      <Pressable
        style={({ pressed }) => [styles.detailsSummary, pressed && pressedStyle]}
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
      >
        <DisclosureChevron expanded={expanded} collapsedDeg={0} expandedDeg={90}>
          <ChevronRight size={14} color={colors.textSecondary} strokeWidth={2.2} />
        </DisclosureChevron>
        <Text style={[summaryStyle, styles.detailsSummaryText]}>{summary}</Text>
      </Pressable>
      {expanded ? <View style={styles.detailsBody}>{children}</View> : null}
    </View>
  )
}
