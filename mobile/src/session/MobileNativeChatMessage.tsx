import { memo, useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react'
import { Text, View } from 'react-native'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { MobileNativeChatLongPressContent as Content } from './MobileNativeChatLongPressContent'
import { splitNativeChatBlocks } from '../../../src/shared/native-chat/tools/native-chat-tool-fold'
import { selectActiveToolCall } from '../../../src/shared/native-chat/tools/native-chat-tool-activity'
import {
  isImageRefBlock,
  isSubagentGroupBlock,
  isTextBlock
} from '../../../src/shared/native-chat-types'
import {
  isRenderableSubagentGroup,
  withoutSubagentGroupTwins
} from '../../../src/shared/native-chat-subagent-summary'
import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatToolCallBlock
} from '../../../src/shared/native-chat-types'
import { MobileSourceCopyButton } from '../components/MobileSourceCopyButton'
import { nativeChatMessagePlainText } from './mobile-native-chat-message-plain-text'
import { deriveNativeChatRowContent } from '../../../src/shared/native-chat-row-content'
import {
  MobileNativeChatGroupedThought,
  MobileNativeChatReasoningRow
} from './MobileNativeChatReasoningRow'
import { mobileNativeChatRowId } from './mobile-native-chat-reading-place'
import { nativeChatWorkRunEntries } from '../../../src/shared/native-chat-work-run'
import { nativeChatReasoningDisclosureKey } from '../../../src/shared/native-chat-reasoning-row'
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
} from '../../../src/shared/native-chat/input/native-chat-ask-row'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
import { MobileNativeChatSubagentGroup } from './MobileNativeChatSubagentGroup'
import { ToolRun } from './MobileNativeChatToolRun'
import type { NativeChatTurnStatus } from './use-mobile-native-chat-turn-status'
import { styles } from './mobile-native-chat-message-styles'
import { agentMessageAttribution } from './mobile-agent-message-attribution'
import { MobileNativeChatVisualContext } from './mobile-native-chat-visual-context'
import { useMobileNativeChatFullMessage } from './MobileNativeChatFullContent'
import { MobileNativeChatPacedProse } from './MobileNativeChatPacedProse'
import { Prose } from './MobileNativeChatProse'

function MobileNativeChatMessageImpl({
  message: rowMessage,
  rowKey,
  runOwner,
  mayStillGrow = false,
  previousTodoWrite,
  previousUpdatePlan,
  fontScale = 1,
  onOpenFile,
  turnStatus,
  turnStatusAbove = false,
  turnExpanded,
  turnKey,
  onToggleTurn,
  activeTurnIsWorking,
  trailingRun,
  workRun,
  joinsWorkRun = false,
  foldedAway = false,
  openReasoning,
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
  // Stable placement key survives older messages joining a folded row.
  rowKey?: string
  runOwner?: string
  // Only the newest live assistant row can still grow.
  mayStillGrow?: boolean
  // Compare plan updates against the prior write, not an empty checklist.
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
  fontScale?: number
  onOpenFile?: (relativePath: string) => void
  turnStatus?: NativeChatTurnStatus | null
  turnStatusAbove?: boolean
  turnExpanded?: boolean
  turnKey?: string
  onToggleTurn?: (turnKey: string) => void
  activeTurnIsWorking?: boolean
  trailingRun?: boolean
  // The run’s first row draws all members; later members render no duplicate activity.
  workRun?: readonly NativeChatMessage[]
  joinsWorkRun?: boolean
  foldedAway?: boolean
  openReasoning?: ReadonlySet<string>
  structuredActivityUi?: boolean
  // Hide the reasoning row while the live activity line discloses the same block.
  reasoningIsLive?: boolean
  reasoningExpanded?: boolean
  onToggleReasoning?: (key: string) => void
  unsentNotice?: string
  receipt?: NativeChatResolvedPrompt
  awaiting?: boolean
  subagentGroupsOpen?: ReadonlySet<string>
  onToggleSubagentGroup?: (groupId: string) => void
  userMessageOpen?: boolean
  onToggleUserMessage?: (messageId: string) => void
}): React.JSX.Element {
  const { shown: message, showFull, recovery } = useMobileNativeChatFullMessage(rowMessage)
  const attribution = agentMessageAttribution('Message from', message.from)
  const isUser = message.role === 'user' && attribution === null
  const isReasoning = message.role === 'reasoning'
  const { prose, tools: blocksOfTools } = splitNativeChatBlocks(message.blocks)
  const { asks, unansweredAsks, work: ownTools } = nativeChatAskRunBlocks(blocksOfTools)
  const { openActions: openSheet } = useContext(MobileNativeChatRowOverlaysContext)
  const run = useMemo(() => (workRun ? nativeChatWorkRunEntries(workRun) : null), [workRun])
  const tools = run?.blocks ?? ownTools
  const asides = useMemo(() => {
    if (!run) {
      return undefined
    }
    const thought = (thoughtMessage: NativeChatMessage): React.JSX.Element => (
      // Key by thought so later calls cannot remount it.
      <MobileNativeChatGroupedThought
        key={`thought:${thoughtMessage.id}`}
        message={thoughtMessage}
        fontScale={fontScale}
        live={activeTurnIsWorking === true}
        expanded={openReasoning?.has(nativeChatReasoningDisclosureKey(thoughtMessage.id)) === true}
        onToggle={onToggleReasoning}
        onOpenFile={onOpenFile}
        onLongPress={INLINE_TEXT_SELECTION ? undefined : () => openSheet(thoughtMessage)}
      />
    )
    const before = new Map<NativeChatBlock, React.JSX.Element[]>()
    for (const [block, thoughts] of run.thoughtsBefore) {
      before.set(block, thoughts.map(thought))
    }
    return { before, after: run.thoughtsAfter.map(thought) }
  }, [run, fontScale, activeTurnIsWorking, openReasoning, onToggleReasoning, onOpenFile, openSheet])
  const drawnProse = isReasoning ? [] : withoutSubagentGroupTwins(prose)
  const isSystem = message.role === 'system'
  const showToolRun = tools.length > 0
  const askPending = structuredActivityUi
    ? selectActiveToolCall(unansweredAsks, { activeTurnIsWorking }) !== null
    : unansweredAsks.length > 0
  const askRow =
    asks.length > 0 ? (
      <MobileNativeChatAwaitingInputRow
        subject={nativeChatAskRunSubject(asks)}
        pending={askPending}
        fontScale={fontScale}
        listsQuestions={false}
      />
    ) : null
  // A ref keeps the memoized Markdown context stable as the message streams.
  const pressedMessage = useRef(message)
  useLayoutEffect(() => {
    pressedMessage.current = message
  }, [message])
  const openActions = useCallback(() => openSheet(pressedMessage.current), [openSheet])
  const onLongPress = INLINE_TEXT_SELECTION ? undefined : openActions
  const renderVisual = useContext(MobileNativeChatVisualContext) ?? undefined
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
  // Keep answered receipts visible even when their tool run folds away.
  if (joinsWorkRun || (foldedAway && !receipt)) {
    return <>{statusRow}</>
  }
  if (receipt) {
    return (
      <>
        {turnStatusAbove ? statusRow : null}
        <View style={styles.row} testID={mobileNativeChatRowId(rowKey ?? message.id)}>
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
  if (isReasoning && !workRun) {
    const markdown = deriveNativeChatRowContent(message.blocks).markdown
    const draws = markdown.trim().length > 0 && !reasoningIsLive
    return (
      <>
        {turnStatusAbove ? statusRow : null}
        {draws ? (
          <View style={styles.row} testID={mobileNativeChatRowId(rowKey ?? message.id)}>
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
            {showFull}
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
      {}
      {turnStatusAbove ? statusRow : null}
      <View
        style={[styles.row, isUser && styles.rowUser]}
        testID={mobileNativeChatRowId(rowKey ?? message.id)}
      >
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
            <>
              {proseRows(drawnProse.filter(isImageRefBlock))}
              <MobileNativeChatUserMessageFold
                text={deriveNativeChatRowContent(message.blocks).markdown}
                fontScale={fontScale}
                open={userMessageOpen === true}
                onToggle={() => onToggleUserMessage?.(message.id)}
                recovery={recovery}
                status={showFull}
              >
                {proseRows(drawnProse.filter((block) => !isImageRefBlock(block)))}
              </MobileNativeChatUserMessageFold>
            </>
          ) : (
            <MobileNativeChatPacedProse
              rowKey={message.id}
              blocks={drawnProse}
              growingBlock={growingBlock}
              paced={message.role === 'assistant'}
            >
              {(block, index, shown) => proseRow(block, index, shown.text, shown.revealing)}
            </MobileNativeChatPacedProse>
          )}
          {isUser ? null : showFull}
          {askRow}
          {showToolRun ? (
            <ToolRun
              blocks={tools}
              disclosureId={runOwner ?? rowKey ?? message.id}
              asides={asides}
              activeTurnIsWorking={structuredActivityUi ? activeTurnIsWorking : undefined}
              trailing={trailingRun}
              awaitingAnswer={askPending}
              previousTodoWrite={previousTodoWrite}
              previousUpdatePlan={previousUpdatePlan}
              fontScale={fontScale}
              onOpenFile={onOpenFile}
            />
          ) : null}
        </Content>
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
