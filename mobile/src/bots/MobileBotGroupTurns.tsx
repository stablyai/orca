import type { BotGroupTurnDetailCursor } from '../../../src/shared/bots/bot-group-read-schema'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { folderWorkspaceKey } from '../../../src/shared/workspace/identity/workspace-scope'
import { useMobileNativeChatVisualRenderer } from '../session/native-chat/visual/MobileNativeChatVisual'
import { MobileNativeChatVisualContext } from '../session/native-chat/visual/mobile-native-chat-visual-context'
import { MobileNativeChatItemSourceContext } from '../session/native-chat/transcript/projection/mobile-native-chat-item-read'
import { useMobileNativeChatMessageDetail } from '../session/native-chat/transcript/projection/use-mobile-native-chat-message-detail'
import { MobileNativeChatRowOverlaysHost } from '../session/native-chat/transcript/message-actions/MobileNativeChatRowOverlaysHost'
import { Reply, Square } from 'lucide-react-native'
import { foldMobileNativeChatMessages } from '../session/native-chat/transcript/projection/mobile-native-chat-render-data'
import {
  botGroupOperationAdmitted,
  createBotGroupJournalIndexer,
  type indexBotGroupJournal,
  type BotGroupTurn,
  botGroupTurnShowsNothing,
  withBotGroupTurnAnswer
} from '../../../src/shared/bots/bot-group'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { colors } from '../theme/mobile-theme'
import { groupStyles as styles } from './mobile-bot-group-styles'
import { mobileBotAvatarSource } from './host-bot-row-facts'
import { useMobileStructuredAgentSession } from '../session/native-chat/agent-session/use-mobile-structured-agent-session'
import type { StructuredAgentSessionHostSupport } from '../session/native-chat/agent-session/mobile-structured-agent-session-host-support'
import type { StructuredMobileSession } from '../session/native-chat/agent-session/mobile-structured-agent-session-contract'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileNativeChatBotIdentityContext } from '../session/native-chat/mobile-native-chat-bot-identity'
import { MobileNativeChatTurnStatus } from '../session/native-chat/transcript/messages/MobileNativeChatTurnStatus'
import { MobileNativeChatMessage } from '../session/native-chat/transcript/messages/MobileNativeChatMessage'
import { MobileNativeChatMessageTime } from '../session/native-chat/transcript/messages/MobileNativeChatMessageTime'
import { styles as messageStyles } from '../session/native-chat/transcript/messages/mobile-native-chat-message-styles'
import {
  nativeChatTurnFold,
  nativeChatTurnFoldRow
} from '../../../src/shared/native-chat/transcript/folding/native-chat-turn-fold'
import { createStructuredQuestionProjection } from '../../../src/shared/native-chat/transcript/messages/structured-agent-question-projection'
import { projectStructuredAgentStartItem } from '../../../src/shared/native-chat/transcript/messages/structured-agent-start-projection'
import { botCodedText } from '../../../src/shared/bots/bot-failure-copy'
import {
  createBotGroupTurnDetailsHook,
  requestBotGroupTurnPage
} from '../../../src/shared/bots/use-bot-group-turn-details'
import { groupTurnRows } from './bot-group-operations'

export type MobileBotGroupSession = StructuredMobileSession & {
  groupTurnItems: ReturnType<typeof indexBotGroupJournal>
}
const noItems: never[] = []
const useBotGroupTurnDetails = createBotGroupTurnDetailsHook({ useEffect, useRef, useState })
const transcript = createStructuredQuestionProjection(projectStructuredAgentStartItem)

export const MobileBotGroupReader = memo(function Reader({
  turn,
  client,
  support,
  report,
  onError,
  visible,
  connected
}: {
  turn: Pick<BotGroupTurn, 'sessionId' | 'agent'> & {
    operationIds: readonly string[]
    pendingOperationIds: readonly string[]
  }
  client: RpcClient
  support: StructuredAgentSessionHostSupport
  visible: boolean
  connected: boolean
  report: (id: string, session: MobileBotGroupSession | null) => void
  onError: (message: string) => void
}) {
  const session = useMobileStructuredAgentSession({
    client,
    pairedHostClient: client,
    sessionId: turn.sessionId,
    agent: turn.agent,
    enabled: visible,
    connected,
    hostSupport: support,
    onSendError: onError
  })
  const indexJournal = useMemo(() => createBotGroupJournalIndexer(), [])
  const groupTurnItems = useMemo(
    () => indexJournal(session.journal, turn.operationIds),
    [indexJournal, session.journal.items, session.journal.submissions, turn.operationIds]
  )
  const { hasMore, loadingEarlier, loadEarlier, status } = session.session
  useEffect(() => {
    if (
      visible &&
      connected &&
      status === 'ready' &&
      hasMore &&
      !loadingEarlier &&
      // Page only for a turn the session admitted; queued or refused ones have no older rows to find.
      turn.pendingOperationIds.some(
        (id) => groupTurnItems(id).length === 0 && botGroupOperationAdmitted(session.journal, id)
      )
    ) {
      void loadEarlier()
    }
  }, [
    visible,
    connected,
    status,
    hasMore,
    loadingEarlier,
    loadEarlier,
    turn.pendingOperationIds,
    groupTurnItems,
    session.journal
  ])
  const view = useMemo(() => ({ ...session, groupTurnItems }), [session, groupTurnItems])
  useEffect(() => {
    report(turn.sessionId, view)
  }, [turn.sessionId, view, report])
  useEffect(() => () => report(turn.sessionId, null), [turn.sessionId, report])
  return null
})

export function MobileBotGroupTurn({
  groupId,
  threadId,
  turn,
  session,
  onStop,
  onReply,
  client,
  folderId,
  visible
}: {
  groupId: string
  threadId?: string
  turn: BotGroupTurn
  client: RpcClient
  visible: boolean
  folderId?: string
  session?: MobileBotGroupSession
  onStop: () => void
  onReply: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const ended = turn.end !== undefined || turn.reply !== undefined
  const readTurn = session?.groupTurnItems
  const loadDetails = useCallback(
    (before: BotGroupTurnDetailCursor | undefined, signal: AbortSignal) =>
      requestBotGroupTurnPage(
        async (viewer, requestSignal) =>
          groupTurnRows.interpret(
            await groupTurnRows.request(
              client,
              { groupId, threadId, operationId: turn.operationId, before, ...viewer },
              { signal: requestSignal }
            )
          ),
        signal
      ),
    [client, groupId, threadId, turn.operationId]
  )
  const details = useBotGroupTurnDetails(
    loadDetails,
    turn.frozenHistory || (ended && !turn.frozenItems),
    visible
  )
  const { expanded, toggle: toggleExpanded } = details
  const items = useMemo(
    () =>
      turn.frozenItems ??
      (details.items?.length
        ? details.items
        : (readTurn?.(turn.operationId, turn.workerDispatchIds) ?? noItems)),
    [turn.frozenItems, details.items, readTurn, turn.operationId, turn.workerDispatchIds]
  )
  const lifecycle = items.find((item) => item.body.kind === 'turn')?.body
  const clock = lifecycle?.kind === 'turn' ? lifecycle : null
  const replyAheadOfJournal = ended && clock?.state === 'running'
  const savedOutcome = ended && (turn.end !== undefined || !clock || replyAheadOfJournal)
  const queued = session?.queued.holds(turn.operationId)
  const working = !ended && clock?.state === 'running' && !turn.revoked
  const waiting = !clock && !ended
  const source = useMemo(() => ({ client, sessionId: turn.sessionId }), [client, turn.sessionId])
  const rawMessages = useMemo(
    () =>
      withBotGroupTurnAnswer(
        transcript.messages(items).filter((message) => message.role !== 'user'),
        {
          operationId: turn.operationId,
          answer: turn.answer,
          reply: turn.reply,
          endedAt: turn.endedAt
        },
        replyAheadOfJournal
      ),
    [items, turn.operationId, turn.answer, turn.reply, turn.endedAt, replyAheadOfJournal]
  )
  const noReply =
    ended && !turn.reply && !turn.hadWork && !turn.revoked && botGroupTurnShowsNothing(rawMessages)
  const fullContent = useMobileNativeChatMessageDetail(rawMessages, source)
  const messages = useMemo(
    () => foldMobileNativeChatMessages(fullContent.messages, turn.agent),
    [fullContent.messages, turn.agent]
  )
  const visuals = useMobileNativeChatVisualRenderer(source)
  const itemSource = useMemo(
    () => ({ ...source, messageDetail: fullContent.detail }),
    [source, fullContent.detail]
  )
  const imageSource = useMemo(
    () => (folderId ? { client, worktreeId: folderWorkspaceKey(folderId) } : undefined),
    [client, folderId]
  )
  const conversation = useMemo(
    () => ({ surfaceId: turn.operationId, sessionId: turn.sessionId }),
    [turn.operationId, turn.sessionId]
  )
  const identity = useMemo(
    () => ({
      name: turn.botName,
      avatar: mobileBotAvatarSource({
        id: turn.botId,
        name: turn.botName,
        avatar: turn.avatar,
        avatarColor: turn.avatarColor,
        avatarOutfit: turn.avatarOutfit
      }),
      showName: true
    }),
    [turn.botId, turn.botName, turn.avatar, turn.avatarColor, turn.avatarOutfit]
  )
  const settled = ended || (clock !== null && !working)
  const fold = useMemo(
    () =>
      nativeChatTurnFold({
        rows: messages.map((message) =>
          nativeChatTurnFoldRow(message, turn.operationId, undefined)
        ),
        settledTurnKeys: new Set(settled ? [turn.operationId] : []),
        expandedTurnKeys: new Set(expanded ? [turn.operationId] : [])
      }),
    [messages, turn.operationId, settled, expanded]
  )
  // The answer a member asked for closes what shows, unless the shown words already said it: folding
  // may hide the prose that held it.
  const shown = useMemo(
    () =>
      withBotGroupTurnAnswer(
        messages.filter((_, index) => !fold.foldedRows.has(index)),
        { operationId: turn.operationId, answer: turn.answer }
      ),
    [messages, fold, turn.operationId, turn.answer]
  )
  return (
    // Group turns keep the action sheet for every link; the phone's link setting isn't read here.
    <MobileNativeChatRowOverlaysHost
      conversation={conversation}
      imageSource={imageSource}
      linkOpenMode="ask"
    >
      <MobileNativeChatVisualContext.Provider value={visuals}>
        <MobileNativeChatItemSourceContext.Provider value={itemSource}>
          <MobileNativeChatBotIdentityContext.Provider value={identity}>
            <View style={styles.turn}>
              <MobileNativeChatTurnStatus
                pendingLabel={
                  turn.revoked && clock?.state !== 'completed'
                    ? t('bots.groups.memberRemoved', 'Member removed')
                    : waiting
                      ? queued
                        ? t('chat.queuedMessages.queuedState', 'Queued')
                        : turn.error
                          ? t('bots.groups.notStarted', 'Not started')
                          : t('bots.groups.starting', 'Starting…')
                      : savedOutcome && turn.workedMs === undefined
                        ? t('session.agentChildRow.ended', 'Ended')
                        : undefined
                }
                startedAt={clock?.startedAt ?? null}
                workedSeconds={
                  working ? null : ((savedOutcome ? turn.workedMs : clock?.durationMs) ?? 0) / 1000
                }
                verdict={
                  savedOutcome
                    ? turn.end === 'stopped'
                      ? 'cancellation'
                      : turn.end === 'failed'
                        ? 'failure'
                        : 'success'
                    : clock?.outcome
                }
                expanded={expanded}
                onToggleExpanded={
                  turn.frozenHistory ||
                  (ended && !turn.frozenItems) ||
                  fold.foldableTurnKeys.has(turn.operationId)
                    ? toggleExpanded
                    : undefined
                }
                trailing={
                  !turn.revoked && !turn.error && (working || waiting) ? (
                    // The chat's Stop glyph, in the time line's 24pt box.
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('bots.groups.stopValue', 'Stop {{value0}}', {
                        value0: turn.botName
                      })}
                      hitSlop={10}
                      onPress={onStop}
                      style={({ pressed }) => [styles.metaButton, pressed && styles.metaPressed]}
                    >
                      <Square
                        size={13}
                        color={colors.textSecondary}
                        fill={colors.textSecondary}
                        strokeWidth={2.4}
                      />
                    </Pressable>
                  ) : undefined
                }
              />
              {turn.error ? (
                <Text style={[styles.notice, styles.turnNotice]}>
                  {botCodedText(turn.error, turn.failure, t)}
                </Text>
              ) : null}
              {expanded && details.loadEarlier ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={details.loadEarlier}
                  disabled={details.loading}
                >
                  <Text style={[styles.notice, styles.turnNotice]}>
                    {t('bots.groups.loadEarlierMessages', 'Load earlier messages')}
                  </Text>
                </Pressable>
              ) : null}
              {expanded && details.back ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={details.back}
                  disabled={details.loading}
                >
                  <Text style={[styles.notice, styles.turnNotice]}>{t('common.back', 'Back')}</Text>
                </Pressable>
              ) : null}
              {shown.map((message) => (
                <MobileNativeChatMessage
                  key={message.id}
                  message={message}
                  activeTurnIsWorking={working}
                  mayStillGrow={working}
                  withoutMeta
                />
              ))}
              {noReply && !turn.error ? (
                <Text style={[styles.notice, styles.turnNotice]}>
                  {turn.end === 'stopped'
                    ? t('chat.subagents.stoppedBeforeReply', 'Stopped before replying')
                    : t('chat.subagents.noReply', 'Ended without a reply')}
                </Text>
              ) : null}
              {!working && (settled || turn.error || shown.length > 0) ? (
                <View
                  style={[
                    messageStyles.meta,
                    styles.turnMeta,
                    shown.length > 0 && styles.turnMetaUnderRow
                  ]}
                >
                  <MobileNativeChatMessageTime
                    timestamp={
                      messages.findLast((message) => message.timestamp)?.timestamp ??
                      turn.endedAt ??
                      (clock?.state === 'completed' ? clock.completedAt : null)
                    }
                    fontScale={1}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('bots.groups.replyToValue', 'Reply to {{value0}}', {
                      value0: turn.botName
                    })}
                    hitSlop={10}
                    onPress={onReply}
                    style={({ pressed }) => [styles.metaButton, pressed && styles.metaPressed]}
                  >
                    <Reply size={14} color={colors.textMuted} />
                  </Pressable>
                </View>
              ) : null}
            </View>
          </MobileNativeChatBotIdentityContext.Provider>
        </MobileNativeChatItemSourceContext.Provider>
      </MobileNativeChatVisualContext.Provider>
    </MobileNativeChatRowOverlaysHost>
  )
}
