import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import {
  nativeChatReasoningHeadline,
  nativeChatReasoningHeadlineText
} from '../../../src/shared/native-chat-reasoning-row'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-message-styles'

/** A reasoning row, collapsed to its headline; its text mounts only once opened. Desktop parity:
 *  `NativeChatReasoningRow`. */
export function MobileNativeChatReasoningRow({
  message,
  markdown,
  fontScale,
  onOpenFile
}: {
  message: Pick<NativeChatMessage, 'state' | 'completedAt' | 'timestamp'>
  markdown: string
  fontScale: number
  onOpenFile?: (relativePath: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const headline = nativeChatReasoningHeadlineText(nativeChatReasoningHeadline(message))
  const label = nativeChatReasoningHeadlineText({ kind: 'reasoning' })
  return (
    <View>
      <Pressable
        style={({ pressed }) => [styles.reasoningToggle, pressed && styles.reasoningPressed]}
        onPress={() => setExpanded((open) => !open)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        // Desktop's screen-reader prefix: the headline alone does not say what was thought.
        accessibilityLabel={headline === label ? label : `${label}: ${headline}`}
      >
        <Text style={styles.reasoningHeadline} numberOfLines={1}>
          {headline}
        </Text>
        <View style={expanded ? styles.reasoningCaretOpen : undefined}>
          <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} />
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.reasoning}>
          <MobileMarkdown
            content={markdown}
            rangeSelectable
            textScale={1.25 * fontScale}
            onOpenFile={onOpenFile}
          />
        </View>
      ) : null}
    </View>
  )
}
