import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
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
import { createStructuredQuestionProjection } from '../../../src/shared/native-chat/transcript/messages/structured-agent-question-projection'
import { projectStructuredAgentStartItem } from '../../../src/shared/native-chat/transcript/messages/structured-agent-start-projection'
import { botCodedText } from '../../../src/shared/bots/bot-failure-copy'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import { groupTurnRows } from './bot-group-operations'

export type MobileBotGroupSession = StructuredMobileSession & {
  groupTurnItems: ReturnType<typeof indexBotGroupJournal>
}
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
  turn: Pick<BotGroupTurn, 'sessionId' | 'agent'> & { operationIds: readonly string[] }
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
      turn.operationIds.some(
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
    turn.operationIds,
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
  turn,
  session,
  onStop,
  onReply,
  client,
  folderId
}: {
  groupId: string
  turn: BotGroupTurn
  client: RpcClient
  folderId?: string
  session?: MobileBotGroupSession
  onStop: () => void
  onReply: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [expanded, setExpanded] = useState(false)
  // Its own rows, read once when its reader opens an ended turn its chat's loaded page does not hold.
  const [openedItems, setOpenedItems] = useState<AgentJournalRenderItem[] | null>(null)
  const opening = useRef(false)
  const items = useMemo(() => {
    const loaded =
      turn.frozenItems ?? session?.groupTurnItems(turn.operationId, turn.workerDispatchIds)
    const hasTurnRow = loaded?.some((item) => item.body.kind === 'turn')
    return (hasTurnRow ? loaded : (openedItems ?? loaded)) ?? []
  }, [
    turn.frozenItems,
    session?.groupTurnItems,
    turn.operationId,
    turn.workerDispatchIds,
    openedItems
  ])
  const lifecycle = items.find((item) => item.body.kind === 'turn')?.body
  const clock = lifecycle?.kind === 'turn' ? lifecycle : null
  // Saved with its reply when it ended; older saves carry only the reply.
  const ended = turn.end !== undefined || turn.reply !== undefined
  const queued = session?.queued.cards.some((card) => card.messageId === turn.operationId)
  // Running only while its session works and nothing saved its end: a stale loaded row never is.
  const working =
    clock?.state === 'running' && !turn.revoked && !ended && session?.isWorking !== false
  const waiting = !clock && !ended
  const toggleExpanded = () => {
    setExpanded(!expanded)
    if (clock || opening.current) {
      return
    }
    opening.current = true
    groupTurnRows
      .request(client, { groupId, operationId: turn.operationId })
      .then((result) => setOpenedItems(groupTurnRows.interpret(result).items))
      .catch(() => {
        opening.current = false
      })
  }
  const source = useMemo(() => ({ client, sessionId: turn.sessionId }), [client, turn.sessionId])
  const rawMessages = useMemo(
    () =>
      withBotGroupTurnAnswer(
        transcript.messages(items).filter((message) => message.role !== 'user'),
        {
          operationId: turn.operationId,
          answer: turn.answer,
          reply: ended ? turn.reply : undefined
        }
      ),
    [items, turn.operationId, turn.answer, ended, turn.reply]
  )
  const noReply = ended && botGroupTurnShowsNothing(rawMessages)
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
              <View style={styles.row}>
                <View style={styles.grow}>
                  <MobileNativeChatTurnStatus
                    pendingLabel={
                      turn.revoked && clock?.state !== 'completed'
                        ? t('bots.groups.memberRemoved', 'Member removed')
                        : waiting
                          ? queued
                            ? t('chat.queuedMessages.queuedState', 'Queued')
                            : turn.error
                              ? t('bots.groups.notStarted', 'Not started')
                              : t(
                                  'bots.groups.waitingForTheNativeSession',
                                  'Waiting for the native session…'
                                )
                          : !clock && turn.workedMs === undefined
                            ? t('session.agentChildRow.ended', 'Ended')
                            : undefined
                    }
                    startedAt={clock?.startedAt ?? null}
                    workedSeconds={
                      working ? null : ((clock ? clock.durationMs : turn.workedMs) ?? 0) / 1000
                    }
                    verdict={
                      clock
                        ? clock.outcome
                        : turn.end === 'stopped'
                          ? 'cancellation'
                          : turn.end === 'failed'
                            ? 'failure'
                            : ended
                              ? 'success'
                              : undefined
                    }
                    expanded={expanded}
                    onToggleExpanded={clock || ended ? toggleExpanded : undefined}
                  />
                </View>
                {!turn.revoked && !turn.error && (working || waiting) ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('bots.groups.stopValue', 'Stop {{value0}}', {
                      value0: turn.botName
                    })}
                    onPress={onStop}
                  >
                    <Square size={16} color={colors.textSecondary} />
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('bots.groups.replyToValue', 'Reply to {{value0}}', {
                    value0: turn.botName
                  })}
                  onPress={onReply}
                >
                  <Reply size={16} color={colors.textSecondary} />
                </Pressable>
              </View>
              {turn.error ? (
                <Text style={styles.notice}>{botCodedText(turn.error, turn.failure, t)}</Text>
              ) : waiting && !queued ? (
                <Text style={styles.notice}>
                  {t('bots.groups.waitingForTheNativeSession', 'Waiting for the native session…')}
                </Text>
              ) : null}
              {messages.map((message) => (
                <MobileNativeChatMessage
                  key={message.id}
                  message={message}
                  activeTurnIsWorking={working}
                  mayStillGrow={working}
                  foldedAway={
                    !expanded &&
                    !working &&
                    (message.role === 'tool' || message.role === 'reasoning')
                  }
                />
              ))}
              {noReply && !turn.error ? (
                <Text style={styles.notice}>
                  {turn.end === 'stopped'
                    ? t('chat.subagents.stoppedBeforeReply', 'Stopped before replying')
                    : t('chat.subagents.noReply', 'Ended without a reply')}
                </Text>
              ) : null}
            </View>
          </MobileNativeChatBotIdentityContext.Provider>
        </MobileNativeChatItemSourceContext.Provider>
      </MobileNativeChatVisualContext.Provider>
    </MobileNativeChatRowOverlaysHost>
  )
}
