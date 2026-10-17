import { MobileNativeChatImageGallery } from './MobileNativeChatImageGallery'
import { MobileNativeChatFileAttachments } from './MobileNativeChatFileAttachments'
import { splitMobileNativeChatFileAttachments } from './mobile-native-chat-file-attachments'
import { memo, useCallback, useContext, useLayoutEffect, useRef } from 'react'
import { Text, View } from 'react-native'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
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
import type { NativeChatBlock, NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileSourceCopyButton } from '../components/MobileSourceCopyButton'
import { nativeChatMessagePlainText } from './mobile-native-chat-message-plain-text'
import { deriveNativeChatRowContent } from '../../../src/shared/native-chat-row-content'
import { MobileNativeChatReasoningRow } from './MobileNativeChatReasoningRow'
import { MobileNativeChatTurnStatus } from './MobileNativeChatTurnStatus'
import { MobileNativeChatNoticeRow } from './MobileNativeChatNoticeRow'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'
import { MobileNativeChatUserMessageFold } from './MobileNativeChatUserMessageFold'
import { MobileNativeChatMessageTime } from './MobileNativeChatMessageTime'
import { MobileNativeChatAwaitingInputRow } from './MobileNativeChatAwaitingInputRow'
import { MobileNativeChatResolutionReceipt } from './MobileNativeChatResolutionReceipt'
import {
  nativeChatAskRunBlocks,
  nativeChatAskRunSubject
} from '../../../src/shared/native-chat-ask-row'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
import { MobileNativeChatSubagentGroup } from './MobileNativeChatSubagentGroup'
import { ToolRun } from './MobileNativeChatToolRun'
import type { NativeChatTurnStatus } from './use-mobile-native-chat-turn-status'
import { styles } from './mobile-native-chat-message-styles'
import { agentMessageAttribution } from './mobile-agent-message-attribution'
import { MobileNativeChatVisualContext } from './mobile-native-chat-visual-context'
import { MobileNativeChatPacedProse } from './MobileNativeChatPacedProse'
import { Prose } from './MobileNativeChatProse'

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
  unsentNotice,
  receipt,
  awaiting,
  subagentGroupsOpen,
  onToggleSubagentGroup,
  userMessageOpen,
  onToggleUserMessage
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
  /** Why the host did not deliver this message, when it is drawn as not sent. */
  unsentNotice?: string
  receipt?: NativeChatResolvedPrompt
  awaiting?: boolean
  /** The roster groups the reader opened, held by the transcript; only a roster row gets it. */
  subagentGroupsOpen?: ReadonlySet<string>
  onToggleSubagentGroup?: (groupId: string) => void
  userMessageOpen?: boolean
  onToggleUserMessage?: (messageId: string) => void
}): React.JSX.Element {
  // Another agent's message is set apart from the person's bubble, left-aligned and named.
  const attribution = agentMessageAttribution('Message from', message.from)
  const isUser = message.role === 'user' && attribution === null
  const isReasoning = message.role === 'reasoning'
  // Separate the agent's words from its tool activity: prose renders first, the
  // tool calls fold into a collapsible run beneath. The user's own messages get
  // an inverted (filled accent) bubble so they stand apart from agent prose.
  const { prose, tools: blocksOfTools } = splitNativeChatBlocks(message.blocks)
  const { asks, unansweredAsks, work: tools } = nativeChatAskRunBlocks(blocksOfTools)
  // A roster draws as its group row, which replaces its frozen sentence.
  const withoutTwins = withoutSubagentGroupTwins(prose)
  const { files, prose: drawnProse } = isUser
    ? splitMobileNativeChatFileAttachments(withoutTwins)
    : { files: [], prose: withoutTwins }
  const images = message.role === 'system' ? [] : drawnProse.filter(isImageRefBlock)
  const bodyProse =
    message.role === 'system' ? drawnProse : drawnProse.filter((block) => !isImageRefBlock(block))
  // The agent did not write a system row: its words draw as a notice or a faint aside.
  const isSystem = message.role === 'system'
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
  const askPending = structuredActivityUi
    ? selectActiveToolCall(unansweredAsks, { activeTurnIsWorking }) !== null
    : unansweredAsks.length > 0
  const askRow =
    asks.length > 0 && !settledToolsHidden ? (
      <MobileNativeChatAwaitingInputRow
        subject={nativeChatAskRunSubject(asks)}
        pending={askPending}
        fontScale={fontScale}
        listsQuestions={false}
      />
    ) : null
  // A ref keeps the memoized Markdown context stable as the message streams.
  const { openActions: openSheet } = useContext(MobileNativeChatRowOverlaysContext)
  const pressedMessage = useRef(message)
  useLayoutEffect(() => {
    pressedMessage.current = message
  }, [message])
  const openActions = useCallback(() => openSheet(pressedMessage.current), [openSheet])
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
  if (receipt) {
    return (
      <>
        {turnStatusAbove ? statusRow : null}
        <View style={styles.row}>
          <MobileNativeChatResolutionReceipt
            body={receipt}
            awaiting={awaiting}
            fontScale={fontScale}
          />
        </View>
        {turnStatusAbove ? null : statusRow}
      </>
    )
  }
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
        {turnStatusAbove ? null : statusRow}
      </>
    )
  }
  const isChatTurn = message.role === 'user' || message.role === 'assistant'
  const copyText = isChatTurn ? nativeChatMessagePlainText(message) : ''
  const proseRow = (block: NativeChatBlock, index: number, text: string, revealing = false) =>
    isSubagentGroupBlock(block) && isRenderableSubagentGroup(block) ? (
      <MobileNativeChatSubagentGroup
        key={`subagent-group:${block.groupId}`}
        block={block}
        open={subagentGroupsOpen?.has(block.groupId) === true}
        onToggle={onToggleSubagentGroup}
      />
    ) : isSystem ? null : (
      <Prose
        key={index}
        block={block}
        invert={isUser}
        fontScale={fontScale}
        onOpenFile={onOpenFile}
        onLongPress={onLongPress}
        renderVisual={message.role === 'assistant' ? renderVisual : undefined}
        text={text}
        growing={block === growingBlock}
        revealing={revealing}
      />
    )
  const proseRows = (blocks: NativeChatBlock[]) =>
    blocks.map((block, index) => proseRow(block, index, isTextBlock(block) ? block.text : ''))
  return (
    <>
      {/* A turn with no user bubble carries its bar above its first row. */}
      {turnStatusAbove ? statusRow : null}
      <View style={[styles.row, isUser && styles.rowUser]}>
        {images.length > 0 ? (
          <MobileNativeChatImageGallery
            images={images}
            alignToEnd={isUser}
            onLongPress={onLongPress}
          />
        ) : null}
        {files.length > 0 ? (
          <MobileNativeChatFileAttachments files={files} onOpenFile={onOpenFile} />
        ) : null}
        {!isUser || bodyProse.length > 0 || showToolRun || askRow ? (
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
            {/* A roster is not tool activity, so it stays out of the settled-tools collapse. */}
            {isSystem ? (
              <MobileNativeChatNoticeRow
                blocks={drawnProse}
                fontScale={fontScale}
                onOpenFile={onOpenFile}
                onLongPress={onLongPress}
              />
            ) : null}
            {isUser ? (
              // As desktop: the pictures, then the words, folded by desktop's rule on the same text.
              <MobileNativeChatUserMessageFold
                text={deriveNativeChatRowContent(bodyProse).markdown}
                fontScale={fontScale}
                open={userMessageOpen === true}
                onToggle={() => onToggleUserMessage?.(message.id)}
              >
                {proseRows(bodyProse)}
              </MobileNativeChatUserMessageFold>
            ) : (
              <MobileNativeChatPacedProse
                rowKey={message.id}
                blocks={bodyProse}
                growingBlock={growingBlock}
                paced={message.role === 'assistant'}
              >
                {(block, index, shown) => proseRow(block, index, shown.text, shown.revealing)}
              </MobileNativeChatPacedProse>
            )}
            {askRow}
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
        ) : null}
        {unsentNotice ? <Text style={styles.unsentNotice}>{unsentNotice}</Text> : null}
        {/* Always shown, so the row never shifts when copy appears. */}
        {isChatTurn ? (
          <View style={styles.meta}>
            {copyText.length > 0 ? (
              <MobileSourceCopyButton
                key={message.id}
                text={copyText}
                accessibilityLabel="Copy message"
              />
            ) : null}
            <MobileNativeChatMessageTime timestamp={message.timestamp} fontScale={fontScale} />
          </View>
        ) : null}
      </View>
      {turnStatusAbove ? null : statusRow}
    </>
  )
}

export const MobileNativeChatMessage = memo(MobileNativeChatMessageImpl)
