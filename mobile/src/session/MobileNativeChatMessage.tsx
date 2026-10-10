import { isAgentSessionProviderContextBoundary } from '../../../src/shared/agent-session-provider-context'
import { MobileSelectableText as Text } from '../components/MobileSelectableText'
import { memo, useCallback, useContext, useState } from 'react'
import { Image, Text as NativeText, View } from 'react-native'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { MobileNativeChatMessageActionsSheet } from './MobileNativeChatMessageActionsSheet'
import { MobileNativeChatLongPressContent as Content } from './MobileNativeChatLongPressContent'
import { splitNativeChatBlocks } from '../../../src/shared/native-chat-tool-fold'
import { selectActiveToolCall } from '../../../src/shared/native-chat-tool-activity'
import {
  isImageRefBlock,
  isSubagentGroupBlock,
  isTextBlock
} from '../../../src/shared/native-chat-types'
import {
  isRenderableSubagentGroup,
  withoutSubagentGroupTwins
} from '../../../src/shared/native-chat-subagent-summary'
import {
  AGENT_SESSION_HOST_STATUS_COPY,
  isAgentSessionHostStatusPresentation
} from '../../../src/shared/agent-session-host-status-rows'
import type { NativeChatBlock, NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { deriveNativeChatRowContent } from '../../../src/shared/native-chat-row-content'
import { MobileNativeChatReasoningRow } from './MobileNativeChatReasoningRow'
import { MobileNativeChatTurnStatus } from './MobileNativeChatTurnStatus'
import { MobileNativeChatSubagentGroup } from './MobileNativeChatSubagentGroup'
import { ToolRun } from './MobileNativeChatToolRun'
import type { NativeChatTurnStatus } from './use-mobile-native-chat-turn-status'
import { isRenderableImageUri } from './mobile-native-chat-image-preview'
import { styles, TEXT_SIZE } from './mobile-native-chat-message-styles'
import { agentMessageAttribution } from './mobile-agent-message-attribution'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../src/shared/native-chat-visual-directive'
import {
  MobileNativeChatVisualContext,
  type MobileNativeChatVisualRender
} from './mobile-native-chat-visual-context'

function Prose({
  block,
  invert,
  fontScale,
  onOpenFile,
  onLongPress,
  renderVisual,
  holdPendingVisual = false
}: {
  block: NativeChatBlock
  invert?: boolean
  fontScale: number
  /** Assistant prose of a structured chat only. */
  renderVisual?: MobileNativeChatVisualRender
  /** The reply may still be growing: a directive still being typed at its tail is held back. */
  holdPendingVisual?: boolean
  onOpenFile?: (relativePath: string) => void
  /** Android only: routes a long press on a link span to the row's actions sheet. */
  onLongPress?: () => void
}): React.JSX.Element | null {
  if (isTextBlock(block)) {
    if (isAgentSessionProviderContextBoundary(block.contextClear)) {
      return (
        <View style={styles.contextBoundary}>
          <Text
            selectable={INLINE_TEXT_SELECTION}
            style={[styles.hostNotice, { fontSize: TEXT_SIZE * fontScale }]}
          >
            {block.text}
          </Text>
        </View>
      )
    }
    if (isAgentSessionHostStatusPresentation(block.presentation)) {
      return (
        <Text
          selectable={INLINE_TEXT_SELECTION}
          style={[styles.hostNotice, { fontSize: TEXT_SIZE * fontScale }]}
        >
          {AGENT_SESSION_HOST_STATUS_COPY[block.presentation]}
        </Text>
      )
    }
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
        content={
          holdPendingVisual && renderVisual
            ? withoutPendingNativeChatVisualDirectiveTail(block.text)
            : block.text
        }
        renderVisual={renderVisual}
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

function MobileNativeChatMessageImpl({
  message,
  mayStillGrow = false,
  toolsExpanded = false,
  fontScale = 1,
  onOpenFile,
  turnStatus,
  turnStatusAbove = false,
  turnExpanded,
  turnKey,
  onToggleTurn,
  activeTurnIsWorking,
  structuredActivityUi = false,
  reasoningIsLive = false,
  reasoningExpanded,
  onToggleReasoning,
  subagentGroupsOpen,
  onToggleSubagentGroup
}: {
  message: NativeChatMessage
  /** The newest assistant row of a live turn with no prompt open: its last text may still grow. */
  mayStillGrow?: boolean
  toolsExpanded?: boolean
  /** Multiplies all chat text sizes for pinch-to-zoom (1 = no change). */
  fontScale?: number
  onOpenFile?: (relativePath: string) => void
  /** This turn's status row, rendered under its opening user message. */
  turnStatus?: NativeChatTurnStatus | null
  /** Render the status above the row: its turn has no user bubble of its own. */
  turnStatusAbove?: boolean
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
  /** This open reasoning block is disclosed by the live activity line, so its row draws nothing. */
  reasoningIsLive?: boolean
  /** The transcript-held disclosure of a reasoning row; one stable handler takes its key. */
  reasoningExpanded?: boolean
  onToggleReasoning?: (key: string) => void
  /** The roster groups the reader opened, held by the transcript; only a roster row gets it. */
  subagentGroupsOpen?: ReadonlySet<string>
  onToggleSubagentGroup?: (groupId: string) => void
}): React.JSX.Element {
  // Another agent's message is set apart from the person's bubble, left-aligned and named.
  const attribution = agentMessageAttribution('Message from', message.from)
  const isUser = message.role === 'user' && attribution === null
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
  // Mount selection UI only for the message being copied.
  const [actionsOpen, setActionsOpen] = useState(false)
  // Keep the memoized Markdown context stable as the message streams.
  const openActions = useCallback(() => setActionsOpen(true), [])
  const onLongPress = INLINE_TEXT_SELECTION ? undefined : openActions
  const renderVisual = useContext(MobileNativeChatVisualContext) ?? undefined
  // Structured replies grow in place: only the last block of the newest row may still be typing.
  const growingBlock =
    message.role === 'assistant' && mayStillGrow && activeTurnIsWorking === true
      ? message.blocks.at(-1)
      : undefined

  const statusRow = turnStatus ? (
    <MobileNativeChatTurnStatus
      startedAt={turnStatus.startedAt}
      workedSeconds={turnStatus.workedSeconds}
      verdict={turnStatus.verdict}
      expanded={turnExpanded ?? false}
      onToggleExpanded={turnKey && onToggleTurn ? () => onToggleTurn(turnKey) : undefined}
    />
  ) : null
  if (isReasoning) {
    // The same text the live line's selector reads, so the two agree on whether there is any.
    const markdown = deriveNativeChatRowContent(message.blocks).markdown
    // Blank, or disclosed by the live activity line: nothing draws, not even an empty row.
    const draws = markdown.trim().length > 0 && !reasoningIsLive
    return (
      <>
        {turnStatusAbove ? statusRow : null}
        {draws ? (
          <View style={styles.row}>
            <MobileNativeChatReasoningRow
              message={message}
              markdown={markdown}
              fontScale={fontScale}
              live={activeTurnIsWorking === true}
              expanded={reasoningExpanded}
              onToggle={onToggleReasoning}
              onOpenFile={onOpenFile}
              onLongPress={onLongPress}
            />
          </View>
        ) : null}
        {actionsOpen ? (
          <MobileNativeChatMessageActionsSheet
            message={message}
            onClose={() => setActionsOpen(false)}
          />
        ) : null}
        {turnStatusAbove ? null : statusRow}
      </>
    )
  }
  return (
    <>
      {/* A turn with no user bubble carries its bar above its first row. */}
      {turnStatusAbove ? statusRow : null}
      <View style={[styles.row, isUser && styles.rowUser]}>
        <Content
          onLongPress={onLongPress}
          style={[
            styles.content,
            isUser && styles.userBubble,
            attribution !== null && styles.agentMessage
          ]}
        >
          {attribution !== null ? (
            <Text selectable={INLINE_TEXT_SELECTION} style={styles.agentAttribution}>
              {attribution}
            </Text>
          ) : null}
          {/* A roster draws as its group row, which replaces its frozen sentence; it is not tool
              activity, so it stays out of the settled-tools collapse. */}
          {withoutSubagentGroupTwins(prose).map((block, index) =>
            isSubagentGroupBlock(block) && isRenderableSubagentGroup(block) ? (
              <MobileNativeChatSubagentGroup
                key={`subagent-group:${block.groupId}`}
                block={block}
                open={subagentGroupsOpen?.has(block.groupId) === true}
                onToggle={onToggleSubagentGroup}
              />
            ) : (
              <Prose
                key={index}
                block={block}
                invert={isUser}
                fontScale={fontScale}
                onOpenFile={onOpenFile}
                onLongPress={onLongPress}
                renderVisual={message.role === 'assistant' ? renderVisual : undefined}
                holdPendingVisual={block === growingBlock}
              />
            )
          )}
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
      {turnStatusAbove ? null : statusRow}
    </>
  )
}

export const MobileNativeChatMessage = memo(MobileNativeChatMessageImpl)
