import { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Brain, ChevronRight } from 'lucide-react-native'
import {
  nativeChatReasoningDisclosureKey,
  nativeChatReasoningHeadline,
  nativeChatReasoningHeadlineText
} from '../../../src/shared/native-chat-reasoning-row'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { colors } from '../theme/mobile-theme'
import { MobileNativeChatLongPressContent } from './MobileNativeChatLongPressContent'
import { styles } from './mobile-native-chat-message-styles'

/** A reasoning row, collapsed to its headline; its text mounts only once opened. Desktop parity:
 *  `NativeChatReasoningRow`. */
export function MobileNativeChatReasoningRow({
  message,
  markdown,
  fontScale,
  live = false,
  expanded: transcriptExpanded = false,
  onToggle,
  onOpenFile,
  onLongPress
}: {
  message: Pick<NativeChatMessage, 'id' | 'state' | 'completedAt' | 'timestamp'>
  markdown: string
  fontScale: number
  /** Drawn inside its working turn: an open row there has not ended. */
  live?: boolean
  /** The transcript's disclosure, keyed like the live line's; absent, the row keeps its own. */
  expanded?: boolean
  onToggle?: (key: string) => void
  onOpenFile?: (relativePath: string) => void
  /** Android only: opens the message's actions sheet, as a long press on any other message does. */
  onLongPress?: () => void
}): React.JSX.Element {
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = onToggle ? transcriptExpanded : localExpanded
  const toggle = () =>
    onToggle ? onToggle(nativeChatReasoningDisclosureKey(message.id)) : setLocalExpanded(!expanded)
  const headline = nativeChatReasoningHeadlineText(nativeChatReasoningHeadline(message, { live }))
  const label = nativeChatReasoningHeadlineText({ kind: 'reasoning' })
  return (
    <View>
      <Pressable
        style={({ pressed }) => [styles.reasoningToggle, pressed && styles.reasoningPressed]}
        onPress={toggle}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        // Desktop's screen-reader prefix: the headline alone does not say what was thought.
        accessibilityLabel={headline === label ? label : `${label}: ${headline}`}
      >
        <Brain size={15} color={colors.textMuted} strokeWidth={2} />
        <Text style={styles.reasoningHeadline} numberOfLines={1}>
          {headline}
        </Text>
        <View style={expanded ? styles.reasoningCaretOpen : undefined}>
          <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} />
        </View>
      </Pressable>
      {expanded ? (
        <MobileNativeChatReasoningBody
          markdown={markdown}
          fontScale={fontScale}
          onOpenFile={onOpenFile}
          onLongPress={onLongPress}
        />
      ) : null}
    </View>
  )
}

/** A reasoning block's text, under its row or the live activity line. Capped and scrollable, so an
 *  open block streaming at the tail cannot grow without bound. */
export function MobileNativeChatReasoningBody({
  markdown,
  fontScale,
  onOpenFile,
  onLongPress
}: {
  markdown: string
  fontScale: number
  onOpenFile?: (relativePath: string) => void
  onLongPress?: () => void
}): React.JSX.Element {
  return (
    <ScrollView style={styles.reasoningBody} nestedScrollEnabled>
      <MobileNativeChatLongPressContent onLongPress={onLongPress} style={styles.reasoning}>
        <MobileMarkdown
          content={markdown}
          rangeSelectable
          textScale={1.25 * fontScale}
          onOpenFile={onOpenFile}
          onLongPress={onLongPress}
        />
      </MobileNativeChatLongPressContent>
    </ScrollView>
  )
}
