import { memo, useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react'
import { Text, View } from 'react-native'
import { INLINE_TEXT_SELECTION } from '../../../../platform/text-selection/inline-text-selection'
import { MobileNativeChatLongPressContent as Content } from '../message-content/MobileNativeChatLongPressContent'
import { splitNativeChatBlocks } from '../../../../../../src/shared/native-chat/tools/native-chat-tool-fold'
import { nativeChatToolRunViewedImages } from '../../../../../../src/shared/native-chat/tools/native-chat-tool-viewed-images'
import { selectActiveToolCall } from '../../../../../../src/shared/native-chat/tools/native-chat-tool-activity'
import * as Chat from '../../../../../../src/shared/native-chat/native-chat-types'
import {
  isRenderableSubagentGroup,
  withoutSubagentGroupTwins
} from '../../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-summary'
import { deriveNativeChatRowContent } from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-row-content'
import { isNativeChatProviderTurnStart } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-provider-turn-start'
import { MobileNativeChatReasoningRow } from '../message-content/MobileNativeChatReasoningRow'
import { useMobileNativeChatRunAsides } from '../use-mobile-native-chat-run-asides'
import { mobileNativeChatRowId } from '../viewport/mobile-native-chat-reading-place'
import { useMobileNativeChatLandedPrompt } from '../viewport/mobile-native-chat-landed-prompt'
import { nativeChatWorkRunEntries } from '../../../../../../src/shared/native-chat/transcript/folding/native-chat-work-run'
import { MobileNativeChatTurnStatus } from './MobileNativeChatTurnStatus'
import { MobileNativeChatNoticeRow } from '../notices/MobileNativeChatNoticeRow'
import { mobileNativeChatBotCardRow } from '../bot-cards/mobile-native-chat-bot-card-row'
import { useMobileFoldedIntoBotRequest } from '../bot-cards/mobile-bot-request-folded-mail'
import { MobileNativeChatTookOverRow } from '../MobileNativeChatBotRowNotes'
import { MobileNativeChatPullRequestEventLine } from './MobileNativeChatPullRequestEventLine'
import { mobileNativeChatBotItemRow } from './MobileNativeChatBotItemNoteRow'
import { PULL_REQUEST_EVENT_PRESENTATION } from '../../../../../../src/shared/native-chat/transcript/notices/native-chat-pull-request-event'
import { MobileNativeChatRowOverlaysContext } from '../message-actions/mobile-native-chat-row-overlays'
import { MobileNativeChatUserMessageFold } from '../message-content/MobileNativeChatUserMessageFold'
import { TextAttachmentActions } from '../message-actions/MobileNativeChatTextAttachmentActions'
import { MobileNativeChatMessageMeta } from './MobileNativeChatMessageMeta'
import { MobileNativeChatAwaitingInputRow } from './MobileNativeChatAwaitingInputRow'
import { MobileNativeChatResolutionReceipt } from './MobileNativeChatResolutionReceipt'
import {
  nativeChatAskRunBlocks,
  nativeChatAskRunSubject
} from '../../../../../../src/shared/native-chat/input/questions/native-chat-ask-row'
import type { NativeChatResolvedPrompt } from '../../../../../../src/shared/native-chat/input/questions/native-chat-resolution-receipt'
import { MobileNativeChatSubagentGroup } from './MobileNativeChatSubagentGroup'
import { MobileNativeChatBackgroundTaskRun } from './MobileNativeChatBackgroundTaskRun'
import { withoutBackgroundTaskRows } from '../../../../../../src/shared/native-chat/input/task-lists/native-chat-background-task-row'
import { ToolRun } from '../tool-results/MobileNativeChatToolRun'
import type { NativeChatTurnStatus } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import { styles } from './mobile-native-chat-message-styles'
import { MobileNativeChatAgentMessageCard } from '../agent-messages/MobileNativeChatAgentMessageCard'
import { mobileAutomationRow } from '../MobileAutomationSavedRow'
import { MobileNativeChatVisualContext } from '../../visual/mobile-native-chat-visual-context'
import { useMobileNativeChatFullMessage } from '../message-content/MobileNativeChatFullContent'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileNativeChatAnswerProse } from '../message-content/MobileNativeChatAnswerProse'
import { Prose, userProseText } from '../message-content/MobileNativeChatProse'
import * as Marks from './MobileNativeChatUserMessageMarks'

function MobileNativeChatMessageImpl({
  message: rowMessage,
  rowKey,
  runOwner,
  mayStillGrow = false,
  previousTodoWrite,
  previousUpdatePlan,
  fontScale = 1,
  turnStatus,
  turnStatusAbove = false,
  turnExpanded,
  turnKey,
  rewindable,
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
  userMessageOpen,
  onToggleUserMessage
}: {
  message: Chat.NativeChatMessage
  // Stable placement key survives older messages joining a folded row.
  rowKey?: string
  runOwner?: string
  // Only the newest live assistant row can still grow.
  mayStillGrow?: boolean
  // Compare plan updates against the prior write, not an empty checklist.
  previousTodoWrite?: Chat.NativeChatToolCallBlock
  previousUpdatePlan?: Chat.NativeChatToolCallBlock
  fontScale?: number
  turnStatus?: NativeChatTurnStatus | null
  turnStatusAbove?: boolean
  turnExpanded?: boolean
  turnKey?: string
  /** The chat may rewind to this row, by desktop's `nativeChatRowOffersRewind`. */
  rewindable?: true
  onToggleTurn?: (turnKey: string) => void
  activeTurnIsWorking?: boolean
  trailingRun?: boolean
  // The run’s first row draws all members; later members render no duplicate activity.
  workRun?: readonly Chat.NativeChatMessage[]
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
  userMessageOpen?: boolean
  onToggleUserMessage?: (messageId: string) => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { shown: message, showFull, recovery } = useMobileNativeChatFullMessage(rowMessage)
  const agentFrom = message.role === 'user' || message.agentStart ? message.from : undefined
  const foldedIntoRequest = useMobileFoldedIntoBotRequest(agentFrom)
  const isUser = message.role === 'user' && !agentFrom
  const isReasoning = message.role === 'reasoning'
  const { prose, tools: blocksOfTools } = splitNativeChatBlocks(message.blocks)
  const { asks, unansweredAsks, work: ownTools } = nativeChatAskRunBlocks(blocksOfTools)
  const { openActions: openSheet } = useContext(MobileNativeChatRowOverlaysContext)
  const run = useMemo(() => (workRun ? nativeChatWorkRunEntries(workRun) : null), [workRun])
  const tools = run?.blocks ?? ownTools
  const asides = useMobileNativeChatRunAsides(run, {
    fontScale,
    live: activeTurnIsWorking === true,
    openReasoning,
    onToggleReasoning,
    openSheet
  })
  // Asks and prose read no files, so the run's own blocks or this message's give the same images.
  const viewedImages = useMemo(
    () => nativeChatToolRunViewedImages(run?.blocks ?? message.blocks),
    [run, message.blocks]
  )
  // Task rows replace their plain-text twins, which the host writes for readers without task blocks.
  const { backgroundTasks } = deriveNativeChatRowContent(message.blocks)
  const drawnProse = isReasoning
    ? []
    : withoutSubagentGroupTwins(
        backgroundTasks.length > 0 ? withoutBackgroundTaskRows(prose) : prose
      )
  const isSystem = message.role === 'system'
  const pullRequestEvent = isSystem
    ? drawnProse.find(
        (block): block is Chat.NativeChatTextBlock =>
          Chat.isTextBlock(block) && block.presentation === PULL_REQUEST_EVENT_PRESENTATION
      )
    : undefined
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
  const rowId = rowKey ?? message.id
  const landed = useMobileNativeChatLandedPrompt(isUser ? rowId : undefined)
  const withStatus = (row: React.ReactNode) => (
    <>
      {turnStatusAbove ? statusRow : null}
      {row}
      {turnStatusAbove ? null : statusRow}
    </>
  )
  const botRow = mobileNativeChatBotCardRow(message, rowId, fontScale, foldedIntoRequest)
  if (botRow) {
    return botRow
  }
  // A hand-over: its divider, then any goal as the owner's message (the projection gave it those words).
  const tookOver = message.orcaNotice === 'took-over' ? message.tookOver : undefined
  if (message.orcaNotice === 'took-over' && !tookOver?.goal) {
    return tookOver ? (
      <MobileNativeChatTookOverRow rowId={rowId} workspace={tookOver.workspace} />
    ) : (
      <View testID={mobileNativeChatRowId(rowId)} />
    )
  }
  const automationRow = mobileAutomationRow(message, isUser, rowKey, fontScale)
  if (automationRow) {
    return automationRow
  }
  const botItemRow = receipt ? null : mobileNativeChatBotItemRow(message, rowId, fontScale)
  // Keep answered receipts visible even when their tool run folds away; a provider turn mark draws only its bar.
  const barOnly = joinsWorkRun || (foldedAway && !receipt) || isNativeChatProviderTurnStart(message)
  if (barOnly || botItemRow) {
    return withStatus(barOnly ? null : botItemRow)
  }
  if (receipt) {
    return withStatus(
      <View style={styles.row} testID={mobileNativeChatRowId(rowId)}>
        <MobileNativeChatResolutionReceipt
          body={receipt}
          awaiting={awaiting}
          fontScale={fontScale}
        />
      </View>
    )
  }
  if (isReasoning && !workRun) {
    const markdown = deriveNativeChatRowContent(message.blocks).markdown
    const draws = markdown.trim().length > 0 && !reasoningIsLive
    return withStatus(
      draws && (
        <View style={styles.row} testID={mobileNativeChatRowId(rowId)}>
          <MobileNativeChatReasoningRow
            message={message}
            markdown={markdown}
            fontScale={fontScale}
            live={activeTurnIsWorking === true}
            expanded={reasoningExpanded}
            onToggle={onToggleReasoning}
            onLongPress={onLongPress}
          />
          {showFull}
        </View>
      )
    )
  }
  const isChatTurn = message.role === 'user' || message.role === 'assistant'
  // Paced prose calls this from its own renders too, so the key must not depend on earlier calls.
  const proseRow = (block: Chat.NativeChatBlock, key: number, text: string, revealing = false) => {
    const textKey = `${message.id}:text:${key}`
    return Chat.isSubagentGroupBlock(block) && isRenderableSubagentGroup(block) ? (
      <MobileNativeChatSubagentGroup
        key={`subagent-group:${block.groupId}`}
        block={block}
        fontScale={fontScale}
      />
    ) : isSystem ? null : isUser && structuredActivityUi && Chat.isTextBlock(block) ? (
      <View key={textKey}>
        <Prose
          block={block}
          userMessage
          fontScale={fontScale}
          onLongPress={onLongPress}
          {...userProseText(message, text)}
        />
        <TextAttachmentActions
          text={text}
          pastedText={t('chat.textAttachmentPreview.pastedText', 'Pasted text')}
        />
      </View>
    ) : (
      <Prose
        key={key}
        rowKey={textKey}
        block={block}
        userMessage={isUser}
        fontScale={fontScale}
        onLongPress={onLongPress}
        renderVisual={message.role === 'assistant' ? renderVisual : undefined}
        text={text}
        growing={block === growingBlock}
        revealing={revealing}
      />
    )
  }
  const proseRows = (blocks: Chat.NativeChatBlock[]) =>
    blocks.map((block, index) => proseRow(block, index, Chat.isTextBlock(block) ? block.text : ''))
  const userBubble = landed ? [styles.userBubble, styles.landedPrompt] : styles.userBubble
  return (
    <>
      {tookOver ? <MobileNativeChatTookOverRow workspace={tookOver.workspace} /> : null}
      {turnStatusAbove ? statusRow : null}
      <View style={[styles.row, isUser && styles.rowUser]} testID={mobileNativeChatRowId(rowId)}>
        <Marks.MobileNativeChatConnectorMarks message={message} tagged={!agentFrom} end={isUser} />
        <Content onLongPress={onLongPress} style={[styles.content, isUser && userBubble]}>
          {agentFrom ? (
            <MobileNativeChatAgentMessageCard
              message={message}
              from={agentFrom}
              fontScale={fontScale}
              attachments={proseRows(drawnProse.filter(Chat.isImageRefBlock))}
              onLongPress={onLongPress}
              status={showFull}
            />
          ) : (
            <>
              {/* A roster is not tool activity, so it stays out of the settled-tools collapse. */}
              {pullRequestEvent ? (
                <MobileNativeChatPullRequestEventLine
                  block={pullRequestEvent}
                  messageId={message.id}
                  timestamp={message.timestamp}
                  fontScale={fontScale}
                  onLongPress={onLongPress}
                />
              ) : isSystem ? (
                <MobileNativeChatNoticeRow
                  blocks={drawnProse}
                  fontScale={fontScale}
                  onLongPress={onLongPress}
                  cardId={message.id}
                  timestamp={message.timestamp}
                />
              ) : null}
              {isUser ? (
                <>
                  {proseRows(drawnProse.filter(Chat.isImageRefBlock))}
                  <MobileNativeChatUserMessageFold
                    text={deriveNativeChatRowContent(message.blocks).markdown}
                    fontScale={fontScale}
                    open={userMessageOpen === true}
                    onToggle={() => onToggleUserMessage?.(message.id)}
                    recovery={recovery}
                    status={showFull}
                  >
                    {proseRows(drawnProse.filter((block) => !Chat.isImageRefBlock(block)))}
                  </MobileNativeChatUserMessageFold>
                </>
              ) : (
                <MobileNativeChatAnswerProse
                  rowKey={message.id}
                  blocks={drawnProse}
                  growingBlock={growingBlock}
                  paced={message.role === 'assistant'}
                  fontScale={fontScale}
                >
                  {(block, index, shown) => proseRow(block, index, shown.text, shown.revealing)}
                </MobileNativeChatAnswerProse>
              )}
              {isUser ? null : showFull}
            </>
          )}
          {(isReasoning ? [] : backgroundTasks).map((task) => (
            <MobileNativeChatBackgroundTaskRun
              key={task.taskId}
              block={task}
              fontScale={fontScale}
            />
          ))}
          {askRow}
          {showToolRun ? (
            <ToolRun
              blocks={tools}
              disclosureId={runOwner ?? rowId}
              asides={asides}
              activeTurnIsWorking={structuredActivityUi ? activeTurnIsWorking : undefined}
              trailing={trailingRun}
              awaitingAnswer={askPending}
              previousTodoWrite={previousTodoWrite}
              previousUpdatePlan={previousUpdatePlan}
              fontScale={fontScale}
              viewedImages={
                viewedImages.length > 0
                  ? // Keyed by path: a read finishing late inserts above images already loaded.
                    viewedImages.map((image) => (
                      <Prose
                        key={image.path}
                        block={image}
                        text=""
                        fontScale={fontScale}
                        onLongPress={onLongPress}
                      />
                    ))
                  : undefined
              }
            />
          ) : null}
        </Content>
        {isUser ? <Marks.MobileNativeChatUserMessageNotes message={message} /> : null}
        {unsentNotice ? <Text style={styles.unsentNotice}>{unsentNotice}</Text> : null}
        {/* Always shown, so the row never shifts when copy appears. */}
        {isChatTurn && !agentFrom ? (
          <MobileNativeChatMessageMeta
            message={message}
            rowKey={rowKey ?? message.id}
            fontScale={fontScale}
            rewindable={rewindable}
          />
        ) : null}
      </View>
      {turnStatusAbove ? null : statusRow}
    </>
  )
}

export const MobileNativeChatMessage = memo(MobileNativeChatMessageImpl)
