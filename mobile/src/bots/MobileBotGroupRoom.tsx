import { MobileBotGroupTranscript } from './MobileBotGroupTranscript'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileBotGroupReader, MobileBotGroupTurn } from './MobileBotGroupTurns'
import { useCallback, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronLeft, Ellipsis, ListChecks } from '../components/icons/app-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useHostProtocolGates } from '../components/host-connection/host-protocol-gates-context'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { colors } from '../theme/mobile-theme'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { isBotAgent } from '../../../src/shared/bot-types'
import { BOTS_ITEMS_RUNTIME_CAPABILITY } from '../../../src/shared/bot-runtime-capabilities'
import { MobileBotGroupItems } from './MobileBotGroupItems'
import { MobileBotGroupRepliesSheet } from './MobileBotGroupRepliesSheet'
import { MobileBotGroupApprovalDock } from './MobileBotGroupApprovalDock'
import { botGroupOwnerMessageBlocks } from '../../../src/shared/bots/bot-group'
import { botGroupReplyDraft } from '../../../src/shared/bots/bot-group-mentions'
import { useMobileBotGroupComposer } from './use-mobile-bot-group-composer'
import { confirmMobileBotGroupDelete } from './mobile-bot-group-delete'
import { botGroupMenuActions } from './bot-group-menu-actions'
import { botGroupRoomOrder } from '../../../src/shared/bots/bot-group-room-order'
import { MobileBotGroupPeerRequestLine } from './MobileBotGroupPeerRequestLine'
import { groupNewThread, groupSend, groupStop } from './bot-group-operations'
import { MobileBotGroupRoomBar } from './MobileBotGroupRoomBar'
import { MobileBotFaceStack } from './MobileBotFaceStack'
import { mobileBotAvatarSource } from './host-bot-row-facts'
import { useMobileBotGroupTranscript } from './use-mobile-bot-group-transcript'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { groupStyles as styles } from './mobile-bot-group-styles'
import { MobileBotGroupMembers } from './MobileBotGroupMembers'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { ModelPill } from '../session/native-chat/input/session-options/MobileNativeChatSessionOptionRows'
import { MobileNativeChatComposer } from '../session/native-chat/composer/MobileNativeChatComposer'
import { structuredAgentSessionHostSupport } from '../session/native-chat/agent-session/mobile-structured-agent-session-host-support'
import type { MobileBotGroupSession } from './MobileBotGroupTurns'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileNativeChatMessage } from '../session/native-chat/transcript/messages/MobileNativeChatMessage'
import { MobileNativeChatSendErrorBanner } from '../session/native-chat/status/MobileNativeChatSendErrorBanner'
import { mobileBotGroupDraftKey, useMobileBotGroupDraft } from './use-mobile-bot-group-draft'
import { closeMobileNativeChatTabDraft } from '../session/native-chat/composer/drafts/mobile-native-chat-draft-store'
import { MobileNativeChatInputLockStatus } from '../session/native-chat/composer/field/MobileNativeChatInputLockStatus'
import type { MobileNativeChatHostOutage } from '../session/native-chat/status/mobile-native-chat-host-outage'

export function MobileBotGroupRoom({
  client,
  groupId,
  hostId,
  visible = true,
  connected = true,
  outage = null,
  hostName
}: {
  client: RpcClient
  groupId: string
  hostId: string
  visible?: boolean
  connected?: boolean
  outage?: MobileNativeChatHostOutage | null
  /** The computer the group runs on, for "Studio Mac is offline." */
  hostName: string
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const { hostCapabilities } = useHostProtocolGates()
  const support = useMemo(
    () => structuredAgentSessionHostSupport(hostCapabilities ?? []),
    [hostCapabilities]
  )
  // The original room, or one of the group's threads.
  const [threadId, setThreadId] = useState<string | undefined>()
  const roomId = threadId ?? groupId
  const composerDraft = useMobileBotGroupDraft(hostId, roomId)
  const { text: draft, edit: setDraft } = composerDraft
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<'actions' | 'members' | 'replies' | null>(null)
  const [startingThread, setStartingThread] = useState(false)
  const [itemsOpen, setItemsOpen] = useState(false)
  const itemsOnPhone = hostCapabilities?.includes(BOTS_ITEMS_RUNTIME_CAPABILITY) === true
  const [sessions, setSessions] = useState<ReadonlyMap<string, MobileBotGroupSession>>(new Map())
  const report = useCallback(
    (id: string, session: MobileBotGroupSession | null) =>
      setSessions((previous) => {
        const next = new Map(previous)
        if (session) {
          next.set(id, session)
        } else {
          next.delete(id)
        }
        return next
      }),
    []
  )
  const onError = useCallback((message: string) => setError(message), [])
  const {
    data,
    group: anyRoomGroup,
    apply,
    bots,
    needsYou,
    itemReads,
    itemMemberIds,
    loadEarlier
  } = useMobileBotGroupTranscript(client, groupId, threadId, hostId, visible && connected, setError)
  const group = data?.group
  const readers = useMemo(
    () =>
      group?.members.flatMap((member) => {
        const bot = bots.find((bot) => bot.id === member.botId)
        return bot && isBotAgent(bot.agent)
          ? [
              {
                sessionId: member.sessionId,
                agent: bot.agent,
                operationIds:
                  data?.messages.flatMap((message) =>
                    message.turns
                      .filter((turn) => turn.sessionId === member.sessionId && !turn.revoked)
                      .map((turn) => turn.operationId)
                  ) ?? []
              }
            ]
          : []
      }) ?? [],
    [group?.members, bots, data?.messages]
  )
  const { recipientId, roomMentions, audience } = useMobileBotGroupComposer(group, bots, draft)
  const selectedMember = group?.members.find((member) => member.botId === recipientId)
  const chosen = selectedMember && sessions.get(selectedMember.sessionId)
  const stop = async (botId?: string) => {
    try {
      const result = groupStop.interpret(
        await groupStop.request(client, { groupId, botId, threadId })
      )
      const refused = result.results.find((result) => !result.ok)
      if (refused) {
        setError(refused.refusal?.message ?? 'Stop could not be confirmed.')
      }
    } catch (error) {
      setError(String(error))
    }
  }
  const working =
    group?.members.some((member) => sessions.get(member.sessionId)?.isWorking) ?? false
  const startThread = async () => {
    if (startingThread) {
      return
    }
    setStartingThread(true)
    try {
      const result = groupNewThread.interpret(await groupNewThread.request(client, { groupId }))
      setThreadId(result.threadId)
    } catch (error) {
      setError(String(error))
    } finally {
      setStartingThread(false)
    }
  }
  const memberFaces = (group?.members ?? []).flatMap((member) => {
    const bot = bots.find((bot) => bot.id === member.botId)
    return bot ? [{ id: bot.id, avatar: mobileBotAvatarSource(bot) }] : []
  })
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {readers.map((turn) => (
        <MobileBotGroupReader
          key={turn.sessionId}
          turn={turn}
          client={client}
          support={support}
          report={report}
          onError={onError}
          visible={visible}
          connected={connected}
        />
      ))}
      <NavBar
        leading={
          <NavBarButton
            icon={ChevronLeft}
            accessibilityLabel={t('bots.groups.back', 'Back')}
            onPress={() => router.back()}
          />
        }
        title={anyRoomGroup?.name ?? t('bots.groups.group', 'Group')}
        trailing={
          <>
            {itemsOnPhone ? (
              <NavBarButton
                icon={ListChecks}
                active={itemsOpen}
                accessibilityLabel={t('session.header.items', 'Items')}
                onPress={() => setItemsOpen(true)}
              />
            ) : null}
            <NavBarButton
              icon={Ellipsis}
              accessibilityLabel={t('bots.groups.groupActions', 'Group actions')}
              onPress={() => setMenu('actions')}
            />
          </>
        }
      />
      {anyRoomGroup?.threads?.length || threadId ? (
        <MobileBotGroupRoomBar
          group={anyRoomGroup ?? { name: '', threads: [] }}
          threadId={threadId}
          createDisabled={!connected || startingThread}
          onOpenRoom={setThreadId}
          onNewThread={() => void startThread()}
        />
      ) : null}
      <MobileBotGroupTranscript client={client} roomId={roomId} data={data}>
        {data?.hasEarlier ? (
          <Pressable accessibilityRole="button" onPress={() => void loadEarlier()}>
            <Text style={styles.notice}>
              {t('bots.groups.loadEarlierMessages', 'Load earlier messages')}
            </Text>
          </Pressable>
        ) : null}
        {botGroupRoomOrder(data?.messages ?? []).map((message) => (
          <View key={message.id}>
            {message.author.kind === 'owner' ? (
              <MobileNativeChatMessage
                message={{
                  id: message.id,
                  role: 'user',
                  blocks: botGroupOwnerMessageBlocks(message),
                  timestamp: message.createdAt,
                  source: 'transcript',
                  ...(message.automationRun ? { automationRun: message.automationRun } : {})
                }}
              />
            ) : (
              <MobileBotGroupPeerRequestLine message={message} />
            )}
            {message.turns.map((turn) => (
              <MobileBotGroupTurn
                key={turn.operationId}
                turn={turn}
                client={client}
                folderId={bots.find((bot) => bot.id === turn.botId)?.folderWorkspaceId}
                session={sessions.get(turn.sessionId)}
                onStop={() => void stop(turn.botId)}
                onReply={() =>
                  group && setDraft(botGroupReplyDraft(turn.botId, draft, group, bots))
                }
              />
            ))}
          </View>
        ))}
      </MobileBotGroupTranscript>
      {group ? <MobileBotGroupApprovalDock group={group} bots={bots} sessions={sessions} /> : null}
      <MobileNativeChatInputLockStatus
        lockReason="disconnected"
        waitingText=""
        hostOutage={outage}
      />
      <MobileNativeChatSendErrorBanner message={error} onDismiss={() => setError(null)} />
      <MobileNativeChatComposer
        value={draft}
        onChangeText={setDraft}
        draftScopeKey={composerDraft.key}
        sendSurfaceId={`group:${roomId}`}
        getSendCompletionGeneration={() => 0}
        getComposerEditGeneration={composerDraft.getEditGeneration}
        agent={readers.find((turn) => turn.sessionId === selectedMember?.sessionId)?.agent}
        placeholder={t('bots.groups.composerPlaceholder', 'Message the group, @ to mention a bot')}
        disabled={!connected}
        roomMentions={roomMentions}
        roomReplies={
          <ModelPill
            primary={t('bots.groups.repliesValue', 'Replies: {{value0}}', { value0: audience })}
            secondary={null}
            warning={false}
            accessibleName={t('bots.groups.repliesValue', 'Replies: {{value0}}', {
              value0: audience
            })}
            disabled={!group || !connected}
            onPress={() => setMenu('replies')}
          />
        }
        sessionOptions={
          chosen
            ? {
                isWorking: chosen.isWorking,
                controller: {
                  snapshot: chosen.optionSnapshot,
                  optionSurface: chosen.optionSurface,
                  pendingId: null,
                  setOption: chosen.setStructuredOption,
                  invokeAction: chosen.invokeStructuredOption,
                  recordCommand: () => {}
                }
              }
            : undefined
        }
        stop={working ? { held: false, onStop: () => void stop() } : null}
        onSend={async (text) => {
          if (!group) {
            return false
          }
          composerDraft.clearForSend(text)
          try {
            const result = groupSend.interpret(
              await groupSend.request(client, {
                groupId,
                revision: group.revision,
                threadId,
                messageId: randomV4Uuid(),
                text
              })
            )
            apply({ kind: 'sent', message: result.message })
            setError(null)
            return true
          } catch (error) {
            composerDraft.restoreRefused(text)
            setError(String(error))
            return false
          }
        }}
      />
      <ActionSheetModal
        visible={menu === 'actions'}
        title={group?.name}
        actions={botGroupMenuActions({
          t,
          newThread: {
            renderIcon: () => (
              <MobileBotFaceStack faces={memberFaces} slot={20} ringColor={colors.sheetSurface} />
            ),
            disabled: !connected || startingThread,
            onPress: () => void startThread()
          },
          onManageMembers: () => setMenu('members'),
          onDelete: group
            ? () =>
                confirmMobileBotGroupDelete({
                  client,
                  group,
                  t,
                  onDeleted: () => {
                    for (const room of [
                      group.id,
                      ...(anyRoomGroup?.threads ?? []).map((thread) => thread.id)
                    ]) {
                      closeMobileNativeChatTabDraft(mobileBotGroupDraftKey(hostId, room))
                    }
                    router.back()
                  },
                  onError: setError
                })
            : null
        })}
        onClose={() => setMenu(null)}
      />
      {group ? (
        <MobileBotGroupRepliesSheet
          visible={menu === 'replies'}
          group={group}
          threadId={threadId}
          bots={bots}
          client={client}
          apply={apply}
          onError={setError}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {itemsOnPhone ? (
        <MobileBotGroupItems
          visible={itemsOpen}
          onClose={() => setItemsOpen(false)}
          client={client}
          groupId={groupId}
          hostId={hostId}
          bots={bots}
          needsYou={needsYou}
          reads={itemReads}
          memberIds={itemMemberIds}
          online={connected}
          hostName={hostName}
          onOpenRoom={setThreadId}
        />
      ) : null}
      {menu === 'members' && group ? (
        <MobileBotGroupMembers
          key={`${group.id}:${group.revision}`}
          group={group}
          bots={bots}
          client={client}
          onClose={() => setMenu(null)}
          // The host's change refresh brings the new members with the rows their change rewrote.
          onSaved={() => setMenu(null)}
        />
      ) : null}
    </View>
  )
}
