import { memo, useEffect, useRef, useState } from 'react'
import { Image, Pressable, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { ArrowUp, Copy } from 'lucide-react-native'
import { splitNativeChatBlocks } from '../../../src/shared/native-chat-tool-fold'
import { selectActiveToolCall } from '../../../src/shared/native-chat-tool-activity'
import { isImageRefBlock, isTextBlock } from '../../../src/shared/native-chat-types'
import type { NativeChatBlock, NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { MobileNativeChatTurnStatus } from './MobileNativeChatTurnStatus'
import { ToolRun } from './MobileNativeChatToolRun'
import type { NativeChatTurnStatus } from './use-mobile-native-chat-turn-status'
import { colors } from '../theme/mobile-theme'
import { isRenderableImageUri } from './mobile-native-chat-image-preview'
import { styles, TEXT_SIZE } from './mobile-native-chat-message-styles'
import { nativeChatMessageText } from './mobile-native-chat-message-text'

function Prose({
  block,
  invert,
  fontScale,
  onOpenFile
}: {
  block: NativeChatBlock
  invert?: boolean
  fontScale: number
  onOpenFile?: (relativePath: string) => void
}): React.JSX.Element | null {
  if (isTextBlock(block)) {
    // Inverted (user) bubbles use a fixed dark-on-light text rather than the
    // markdown renderer's light-on-dark palette.
    if (invert) {
      return (
        <Text selectable style={[styles.userText, { fontSize: TEXT_SIZE * fontScale }]}>
          {block.text}
        </Text>
      )
    }
    return (
      <MobileMarkdown content={block.text} textScale={1.25 * fontScale} onOpenFile={onOpenFile} />
    )
  }
  if (isImageRefBlock(block)) {
    // A local preview (composer echo) or real URL renders as a thumbnail; a bare
    // host path (not loadable on the device) falls back to a text placeholder.
    const uri = block.url ?? block.path
    if (isRenderableImageUri(uri)) {
      return (
        <Image
          source={{ uri }}
          style={styles.imageThumb}
          resizeMode="contain"
          accessibilityLabel={block.alt ?? 'Attached image'}
        />
      )
    }
    return (
      <Text style={[styles.imageRef, { fontSize: TEXT_SIZE * fontScale }]}>
        🖼 {block.alt ?? block.path ?? block.url ?? 'image'}
      </Text>
    )
  }
  return null
}

/** Subtle top-right controls for an agent message: copy its prose, or scroll so
 *  this message's top aligns to the top of the viewport. */
function AgentControls({
  onCopy,
  onScrollToTop
}: {
  onCopy: () => void
  onScrollToTop?: () => void
}): React.JSX.Element {
  return (
    <View style={styles.controls}>
      <Pressable
        style={({ pressed }) => [styles.controlButton, pressed && styles.controlPressed]}
        onPress={onCopy}
        hitSlop={8}
        accessibilityLabel="Copy message"
      >
        <Copy size={14} color={colors.textMuted} strokeWidth={2} />
      </Pressable>
      {onScrollToTop ? (
        <Pressable
          style={({ pressed }) => [styles.controlButton, pressed && styles.controlPressed]}
          onPress={onScrollToTop}
          hitSlop={8}
          accessibilityLabel="Scroll this message to top"
        >
          <ArrowUp size={14} color={colors.textMuted} strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  )
}

function MobileNativeChatMessageImpl({
  message,
  toolsExpanded = false,
  fontScale = 1,
  messageIndex,
  onScrollToMessage,
  onOpenFile,
  turnStatus,
  turnExpanded,
  turnKey,
  onToggleTurn,
  activeTurnIsWorking,
  structuredActivityUi = false
}: {
  message: NativeChatMessage
  toolsExpanded?: boolean
  /** Multiplies all chat text sizes for pinch-to-zoom (1 = no change). */
  fontScale?: number
  /** This message's index in the list, paired with onScrollToMessage. */
  messageIndex?: number
  /** Ask the list to align this message's top to the top of the viewport. */
  onScrollToMessage?: (index: number) => void
  onOpenFile?: (relativePath: string) => void
  /** This turn's status row, rendered under a user message (desktop parity). */
  turnStatus?: NativeChatTurnStatus | null
  /** Whether the turn caret has disclosed this turn's activity. */
  turnExpanded?: boolean
  /** Set only when this row's turn has settled and can disclose its activity. */
  turnKey?: string
  /** Stable across renders; the row supplies its own key when tapped. */
  onToggleTurn?: (turnKey: string) => void
  /** Session-level working state for this message's turn; gates the live tool row. */
  activeTurnIsWorking?: boolean
  /** Structured lane only: live tool progress plus the turn-status disclosure. */
  structuredActivityUi?: boolean
}): React.JSX.Element {
  const isUser = message.role === 'user'
  const isReasoning = message.role === 'reasoning'
  const isAgent = !isUser
  // Briefly tint the bubble to confirm a copy landed.
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copyTimer.current) {
        clearTimeout(copyTimer.current)
      }
    },
    []
  )
  // Separate the agent's words from its tool activity: prose renders first, the
  // tool calls fold into a collapsible run beneath. The user's own messages get
  // an inverted (filled accent) bubble so they stand apart from agent prose.
  const { prose, tools } = splitNativeChatBlocks(message.blocks)
  const activeCall = structuredActivityUi
    ? selectActiveToolCall(tools, { activeTurnIsWorking })
    : null
  // A completed turn's activity belongs behind the turn-status caret. Leaving the
  // grouped row visible made a failed child command read as a failed response.
  // The composer's global Tools toggle still overrides this, or it would silently
  // do nothing on every settled turn.
  const settledToolsHidden =
    structuredActivityUi &&
    activeCall == null &&
    activeTurnIsWorking === false &&
    !turnExpanded &&
    !toolsExpanded
  const showToolRun = tools.length > 0 && !settledToolsHidden

  const handleCopy = (): void => {
    const text = nativeChatMessageText(message.blocks)
    if (!text) {
      return
    }
    void Clipboard.setStringAsync(text)
    setCopied(true)
    if (copyTimer.current) {
      clearTimeout(copyTimer.current)
    }
    copyTimer.current = setTimeout(() => setCopied(false), 700)
  }

  // Copy + scroll-to-top, shown inline with the first tool call (or after the
  // prose when there are no tools).
  const controls = isAgent ? (
    <AgentControls
      onCopy={handleCopy}
      onScrollToTop={
        onScrollToMessage && messageIndex !== undefined
          ? () => onScrollToMessage(messageIndex)
          : undefined
      }
    />
  ) : null

  return (
    <>
      <View style={[styles.row, isUser && styles.rowUser]}>
        <View
          style={[
            styles.content,
            isUser && styles.userBubble,
            isReasoning && styles.reasoning,
            copied && styles.copied
          ]}
        >
          {prose.map((block, index) => (
            <Prose
              key={index}
              block={block}
              invert={isUser}
              fontScale={fontScale}
              onOpenFile={onOpenFile}
            />
          ))}
          {showToolRun ? (
            <ToolRun
              // Why: a global toggle intentionally resets all per-run/per-line
              // overrides in one remount, avoiding an effect-driven second render.
              key={`${toolsExpanded ? 'expanded' : 'collapsed'}:${turnExpanded ? 'turn' : 'flat'}`}
              blocks={tools}
              defaultExpanded={turnExpanded || toolsExpanded}
              expandChildren={turnExpanded ? false : toolsExpanded}
              activeCall={activeCall}
              trailing={controls}
              onOpenFile={onOpenFile}
            />
          ) : controls ? (
            <View style={styles.controlsRow}>{controls}</View>
          ) : null}
        </View>
      </View>
      {turnStatus ? (
        <MobileNativeChatTurnStatus
          startedAt={turnStatus.startedAt}
          thinking={turnStatus.thinking}
          workedSeconds={turnStatus.workedSeconds}
          expanded={turnExpanded ?? false}
          onToggleExpanded={turnKey && onToggleTurn ? () => onToggleTurn(turnKey) : undefined}
        />
      ) : null}
    </>
  )
}

export const MobileNativeChatMessage = memo(MobileNativeChatMessageImpl)
