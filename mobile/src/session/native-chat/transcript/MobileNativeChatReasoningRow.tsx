import { mobileNativeChatMemberId } from '../../mobile-native-chat-reading-place'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { MobileNativeChatOwnedScrollView } from '../../MobileNativeChatOwnedScrollView'
import { Brain, ChevronRight } from 'lucide-react-native'
import {
  nativeChatReasoningDisclosureKey,
  nativeChatReasoningHeadline,
  nativeChatReasoningHeadlineText
} from '../../../../../src/shared/native-chat/transcript/native-chat-reasoning-row'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../src/shared/native-chat-row-content'
import { useMobileNativeChatFullMessage } from '../../MobileNativeChatFullContent'
import { MobileMarkdown } from '../../../components/MobileMarkdown'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileNativeChatLongPressContent } from '../../MobileNativeChatLongPressContent'
import { CHAT_PROSE_SCALE, styles } from './mobile-native-chat-message-styles'

/** A grouped thought keeps its own source recovery when its original transcript row is hidden. */
export function MobileNativeChatGroupedThought({
  message,
  ...props
}: Omit<React.ComponentProps<typeof MobileNativeChatReasoningRow>, 'message' | 'markdown'> & {
  message: NativeChatMessage
}): React.JSX.Element {
  const { shown, showFull } = useMobileNativeChatFullMessage(message)
  return (
    <>
      <MobileNativeChatReasoningRow
        {...props}
        message={shown}
        markdown={deriveNativeChatRowContent(shown.blocks).markdown}
      />
      {showFull}
    </>
  )
}

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
  live?: boolean
  // Prefer transcript-held disclosure so recycling a row does not forget it.
  expanded?: boolean
  onToggle?: (key: string) => void
  onOpenFile?: (relativePath: string) => void
  onLongPress?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = onToggle ? transcriptExpanded : localExpanded
  const toggle = () =>
    onToggle ? onToggle(nativeChatReasoningDisclosureKey(message.id)) : setLocalExpanded(!expanded)
  const headline = nativeChatReasoningHeadlineText(nativeChatReasoningHeadline(message, { live }))
  const label = nativeChatReasoningHeadlineText({ kind: 'reasoning' })
  return (
    <View testID={mobileNativeChatMemberId(`thought:${message.id}`)}>
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
          positionKey={nativeChatReasoningDisclosureKey(message.id)}
          markdown={markdown}
          fontScale={fontScale}
          onOpenFile={onOpenFile}
          onLongPress={onLongPress}
        />
      ) : null}
    </View>
  )
}

// Cap reasoning height so an open streaming block cannot grow the transcript without bound.
export function MobileNativeChatReasoningBody({
  positionKey,
  markdown,
  fontScale,
  onOpenFile,
  onLongPress
}: {
  positionKey: string
  markdown: string
  fontScale: number
  onOpenFile?: (relativePath: string) => void
  onLongPress?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  return (
    <MobileNativeChatOwnedScrollView
      positionKey={positionKey}
      style={styles.reasoningBody}
      nestedScrollEnabled
    >
      <MobileNativeChatLongPressContent onLongPress={onLongPress} style={styles.reasoning}>
        <MobileMarkdown
          content={markdown}
          rangeSelectable
          textScale={CHAT_PROSE_SCALE * fontScale}
          onOpenFile={onOpenFile}
          onLongPress={onLongPress}
        />
      </MobileNativeChatLongPressContent>
    </MobileNativeChatOwnedScrollView>
  )
}
