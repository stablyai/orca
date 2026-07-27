import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, SquareChevronRight } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-message-styles'

/** Reasoning folds to a one-line disclosure like a tool run — thinking is
 *  process, not answer, so it stays out of the way until asked for.
 *  `defaultExpanded` lets the global toolbar toggle drive every row at once
 *  while still allowing a per-row override. */
export function MobileNativeChatReasoningRow({
  preview,
  defaultExpanded,
  trailing,
  children
}: {
  preview: string
  defaultExpanded: boolean
  trailing?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultExpanded)
  return (
    <View>
      <View style={styles.toolRunHeader}>
        <Pressable
          style={styles.toolRunToggle}
          onPress={() => setOpen((v) => !v)}
          hitSlop={6}
          accessibilityRole="button"
          // Why: an explicit label replaces the children, so the preview has to
          // be spoken here or a screen reader gets no content while collapsed.
          accessibilityLabel={open ? 'Thinking' : `Thinking: ${preview}`}
          accessibilityState={{ expanded: open }}
        >
          {open ? (
            <ChevronDown size={15} color={colors.textMuted} strokeWidth={2} />
          ) : (
            <SquareChevronRight size={15} color={colors.textMuted} strokeWidth={2} />
          )}
          <Text style={styles.reasoningLabel}>Thinking</Text>
          {open ? null : (
            <Text style={styles.toolRunLabel} numberOfLines={1}>
              {preview}
            </Text>
          )}
        </Pressable>
        {trailing}
      </View>
      {open ? <View style={styles.toolRunBody}>{children}</View> : null}
    </View>
  )
}
