import { useNativeChatProseText } from '../../preferences/native-chat-text-settings'
import { mobileNativeChatMemberId } from '../viewport/mobile-native-chat-reading-place'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { MobileNativeChatOwnedScrollView } from '../viewport/MobileNativeChatOwnedScrollView'
import { Brain, ChevronRight } from 'lucide-react-native'
import {
  nativeChatReasoningDisclosureKey,
  nativeChatReasoningHeadline,
  nativeChatReasoningHeadlineText
} from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-reasoning-row'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-row-content'
import { useMobileNativeChatFullMessage } from './MobileNativeChatFullContent'
import { MobileNativeChatMarkdown } from './MobileNativeChatMarkdown'
import { useMobileNativeChatPacedText } from './use-mobile-native-chat-paced-text'
import {
  MobileNativeChatReplyRevealsContext,
  useMobileNativeChatHeldReveals
} from '../tool-results/mobile-native-chat-reply-reveals'
import { colors } from '../../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { MobileNativeChatLongPressContent } from './MobileNativeChatLongPressContent'
import { styles } from '../messages/mobile-native-chat-message-styles'

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
  onLongPress
}: {
  message: Pick<NativeChatMessage, 'id' | 'state' | 'completedAt' | 'timestamp' | 'journalRevision'>
  markdown: string
  fontScale: number
  live?: boolean
  // Prefer transcript-held disclosure so recycling a row does not forget it.
  expanded?: boolean
  onToggle?: (key: string) => void
  onLongPress?: () => void
}): React.JSX.Element {
  // The body unmounts when collapsed; this row outlives it, so its reveal resumes on reopening.
  const heldReveals = useMobileNativeChatHeldReveals()
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
        <MobileNativeChatReplyRevealsContext.Provider value={heldReveals}>
          <MobileNativeChatReasoningBody
            positionKey={nativeChatReasoningDisclosureKey(message.id)}
            markdown={markdown}
            streaming={live}
            savedRevision={message.journalRevision}
            fontScale={fontScale}
            onLongPress={onLongPress}
          />
        </MobileNativeChatReplyRevealsContext.Provider>
      ) : null}
    </View>
  )
}

// Cap reasoning height so an open streaming block cannot grow the transcript without bound.
export function MobileNativeChatReasoningBody({
  positionKey,
  markdown,
  streaming = false,
  savedRevision,
  fontScale,
  onLongPress
}: {
  positionKey: string
  markdown: string
  /** The turn is live, so the text may end mid-path. */
  streaming?: boolean
  /** The reasoning row's saved journal revision, while it streams. */
  savedRevision?: number
  fontScale: number
  onLongPress?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const prose = useNativeChatProseText(fontScale)
  // Streaming reasoning steps on the reveal clock, so a slow-to-draw block backs off as replies do.
  const shown = useMobileNativeChatPacedText(
    positionKey,
    markdown,
    streaming,
    streaming,
    savedRevision
  )
  return (
    <MobileNativeChatOwnedScrollView
      positionKey={positionKey}
      style={styles.reasoningBody}
      nestedScrollEnabled
    >
      <MobileNativeChatLongPressContent onLongPress={onLongPress} style={styles.reasoning}>
        <MobileNativeChatMarkdown
          content={shown.text}
          streaming={streaming}
          rangeSelectable
          {...prose}
          onLongPress={onLongPress}
        />
      </MobileNativeChatLongPressContent>
    </MobileNativeChatOwnedScrollView>
  )
}
