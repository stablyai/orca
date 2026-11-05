import { useState, type ReactNode } from 'react'
import { Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { styles } from './mobile-markdown-styles'
import { colors, pressedStyle } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

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
  useMobileColorScheme()
  const [expanded, setExpanded] = useState(open)
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <View style={styles.details}>
      <Pressable
        style={({ pressed }) => [styles.detailsSummary, pressed && pressedStyle]}
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
      >
        <Chevron size={14} color={colors.textSecondary} strokeWidth={2.2} />
        <Text style={[summaryStyle, styles.detailsSummaryText]}>{summary}</Text>
      </Pressable>
      {expanded ? <View style={styles.detailsBody}>{children}</View> : null}
    </View>
  )
}
