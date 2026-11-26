import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { memo, useEffect, useMemo, useState } from 'react'
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
  withBotGroupTurnAnswer
} from '../../../src/shared/bots/bot-group'
import {
  botGroupTurnRows,
  botGroupTurnSilent
} from '../../../src/shared/bots/bot-group-member-turn'
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
  turn,
  session,
  onStop,
  onReply,
  client,
  folderId
}: {
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
  const items = useMemo(() => botGroupTurnRows(turn, session?.groupTurnItems), [turn, session])
  const lifecycle = items.find((item) => item.body.kind === 'turn')?.body
  const clock = lifecycle?.kind === 'turn' ? lifecycle : null
  const queued = session?.queued.holds(turn.operationId)
  const working = clock?.state === 'running' && !turn.revoked
  const source = useMemo(() => ({ client, sessionId: turn.sessionId }), [client, turn.sessionId])
  const rawMessages = useMemo(
    () => transcript.messages(items).filter((message) => message.role !== 'user'),
    [items]
  )
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
  const settled = clock !== null && !working
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
  // A member turn that ended saying only the quiet marker told the room nothing: it draws nothing.
  if (botGroupTurnSilent(turn, items)) {
    return null
  }
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
                    : !clock
                      ? queued
                        ? t('chat.queuedMessages.queuedState', 'Queued')
                        : turn.error
                          ? t('bots.groups.notStarted', 'Not started')
                          : t('bots.groups.starting', 'Starting…')
                      : undefined
                }
                startedAt={clock?.startedAt ?? null}
                workedSeconds={clock && working ? null : (clock?.durationMs ?? 0) / 1000}
                verdict={clock?.outcome}
                expanded={expanded}
                onToggleExpanded={
                  fold.foldableTurnKeys.has(turn.operationId)
                    ? () => setExpanded(!expanded)
                    : undefined
                }
                trailing={
                  !turn.revoked && !turn.error && (working || !clock) ? (
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
              {shown.map((message) => (
                <MobileNativeChatMessage
                  key={message.id}
                  message={message}
                  activeTurnIsWorking={working}
                  mayStillGrow={working}
                  withoutMeta
                />
              ))}
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
