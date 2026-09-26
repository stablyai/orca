import { MobileSelectableText as Text } from '../components/MobileSelectableText'
import { memo, useCallback, useState, type ComponentProps, type ReactNode } from 'react'
import { Image, Text as NativeText, Pressable, View } from 'react-native'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { MobileNativeChatMessageActionsSheet } from './MobileNativeChatMessageActionsSheet'
import { splitNativeChatBlocks } from '../../../src/shared/native-chat-tool-fold'
import { selectActiveToolCall } from '../../../src/shared/native-chat-tool-activity'
import { isImageRefBlock, isTextBlock } from '../../../src/shared/native-chat-types'
import type { NativeChatBlock, NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { MobileNativeChatTurnStatus } from './MobileNativeChatTurnStatus'
import { ToolRun } from './MobileNativeChatToolRun'
import type { NativeChatTurnStatus } from './use-mobile-native-chat-turn-status'
import { isRenderableImageUri } from './mobile-native-chat-image-preview'
import { styles, TEXT_SIZE } from './mobile-native-chat-message-styles'

function Prose({
  block,
  invert,
  fontScale,
  onOpenFile,
  onLongPress
}: {
  block: NativeChatBlock
  invert?: boolean
  fontScale: number
  onOpenFile?: (relativePath: string) => void
  /** Android only: routes a long press on a link span to the row's actions sheet. */
  onLongPress?: () => void
}): React.JSX.Element | null {
  if (isTextBlock(block)) {
    // Inverted (user) bubbles use a fixed dark-on-light text rather than the
    // markdown renderer's light-on-dark palette.
    if (invert) {
      return (
        <Text
          selectable={INLINE_TEXT_SELECTION}
          style={[styles.userText, { fontSize: TEXT_SIZE * fontScale }]}
        >
          {block.text}
        </Text>
      )
    }
    return (
      <MobileMarkdown
        content={block.text}
        rangeSelectable
        textScale={1.25 * fontScale}
        onOpenFile={onOpenFile}
        onLongPress={onLongPress}
      />
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
      <NativeText style={[styles.imageRef, { fontSize: TEXT_SIZE * fontScale }]}>
        🖼 {block.alt ?? block.path ?? block.url ?? 'image'}
      </NativeText>
    )
  }
  return null
}

// A plain View unless a long press is wired: a Pressable around every bubble would claim the
// row's taps and show up as one more pressable in the tool-run tests.
function Content({
  onLongPress,
  style,
  children
}: {
  onLongPress?: () => void
  style: ComponentProps<typeof View>['style']
  children: ReactNode
}): React.JSX.Element {
  return onLongPress ? (
    <Pressable onLongPress={onLongPress} style={style}>
      {children}
    </Pressable>
  ) : (
    <View style={style}>{children}</View>
  )
}

function MobileNativeChatMessageImpl({
  message,
  toolsExpanded = false,
  fontScale = 1,
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
  onOpenFile?: (relativePath: string) => void
  /** This settled turn's status row, rendered under its user message. */
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
  // Where inline selection is off (Android), a long press is how the text gets copied. The
  // sheet is mounted only while open, so an idle row costs nothing for it.
  const [actionsOpen, setActionsOpen] = useState(false)
  // Why useCallback: the markdown memoises its text setup on this identity per render.
  const openActions = useCallback(() => setActionsOpen(true), [])
  const onLongPress = INLINE_TEXT_SELECTION ? undefined : openActions

  return (
    <>
      <View style={[styles.row, isUser && styles.rowUser]}>
        <Content
          onLongPress={onLongPress}
          style={[styles.content, isUser && styles.userBubble, isReasoning && styles.reasoning]}
        >
          {prose.map((block, index) => (
            <Prose
              key={index}
              block={block}
              invert={isUser}
              fontScale={fontScale}
              onOpenFile={onOpenFile}
              onLongPress={onLongPress}
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
              onOpenFile={onOpenFile}
            />
          ) : null}
        </Content>
      </View>
      {actionsOpen ? (
        <MobileNativeChatMessageActionsSheet
          message={message}
          onClose={() => setActionsOpen(false)}
        />
      ) : null}
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
