import { botFailureMessage } from './bot-failure-message'
import { MobileBotGroupTranscript } from './MobileBotGroupTranscript'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileBotGroupReader } from './MobileBotGroupTurns'
import { useCallback, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Ellipsis, ListChecks } from '../components/icons/app-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobileSessionKeyboardLift } from '../terminal/session/input-controls/use-mobile-session-keyboard-lift'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useHostProtocolGates } from '../components/host-connection/host-protocol-gates-context'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { colors } from '../theme/mobile-theme'
import { NATIVE_SCREEN_HEADER, ScreenHeader } from '../components/nav-bar/ScreenHeader'
import { isBotAgent } from '../../../src/shared/bot-types'
import {
  BOTS_GROUP_ATTACHMENTS_RUNTIME_CAPABILITY,
  BOTS_ITEMS_RUNTIME_CAPABILITY
} from '../../../src/shared/bot-runtime-capabilities'
import { MobileBotGroupItems } from './MobileBotGroupItems'
import { MobileBotGroupRepliesSheet } from './MobileBotGroupRepliesSheet'
import { MobileBotGroupApprovalDock } from './MobileBotGroupApprovalDock'
import { botGroupReplyDraft } from '../../../src/shared/bots/bot-group-mentions'
import {
  mobileBotGroupSessionOptions,
  useMobileBotGroupComposer
} from './use-mobile-bot-group-composer'
import { MobileBotGroupDeleteConfirm } from './MobileBotGroupDeleteConfirm'
import { botGroupMenuActions } from './bot-group-menu-actions'
import { botGroupRoomOrder } from '../../../src/shared/bots/bot-group-room-order'
import { groupNewThread, groupSend, groupStop } from './bot-group-operations'
import { MobileBotGroupRoomBar } from './MobileBotGroupRoomBar'
import { MobileBotFaceStack } from './MobileBotFaceStack'
import { mobileBotAvatarSource } from './host-bot-row-facts'
import { useMobileBotGroupTranscript } from './use-mobile-bot-group-transcript'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { groupStyles as styles } from './mobile-bot-group-styles'
import { MobileBotGroupMembers } from './MobileBotGroupMembers'
import { MobileBotGroupPost } from './MobileBotGroupPost'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { ModelPill } from '../session/native-chat/input/session-options/MobileNativeChatSessionOptionRows'
import { MobileNativeChatComposer } from '../session/native-chat/composer/MobileNativeChatComposer'
import { MobileNativeChatComposerMenuHost } from '../session/native-chat/composer/menus/MobileNativeChatComposerMenuHost'
import { structuredAgentSessionHostSupport } from '../session/native-chat/agent-session/mobile-structured-agent-session-host-support'
import type { MobileBotGroupSession } from './MobileBotGroupTurns'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileNativeChatSendErrorBanner } from '../session/native-chat/status/MobileNativeChatSendErrorBanner'
import { useMobileBotGroupDraft } from './use-mobile-bot-group-draft'
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
  // The page draws under the keyboard, so the composer rises by what it covers, as a chat's does.
  const keyboardLift = useMobileSessionKeyboardLift(insets.bottom)
  const { hostCapabilities } = useHostProtocolGates()
  const support = useMemo(
    () => structuredAgentSessionHostSupport(hostCapabilities ?? []),
    [hostCapabilities]
  )
  // The original room, or one of the group's threads.
  const [threadId, setThreadId] = useState<string | undefined>()
  const roomId = threadId ?? groupId
  const composerDraft = useMobileBotGroupDraft(hostId, groupId, roomId)
  const { text: draft, edit: setDraft } = composerDraft
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<'actions' | 'members' | 'replies' | 'delete' | null>(null)
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
  const { recipientId, roomMentions, audience, photos, attachPhotos } = useMobileBotGroupComposer(
    group,
    bots,
    composerDraft,
    client,
    hostCapabilities?.includes(BOTS_GROUP_ATTACHMENTS_RUNTIME_CAPABILITY) === true,
    setError
  )
  const selectedMember = group?.members.find((member) => member.botId === recipientId)
  const chosen = selectedMember && sessions.get(selectedMember.sessionId)
  const stop = async (botId?: string) => {
    try {
      const result = groupStop.interpret(
        await groupStop.request(client, { groupId, botId, threadId })
      )
      const refused = result.results.find((result) => !result.ok)
      if (refused) {
        setError(
          refused.refusal?.message ??
            t('bots.groups.stopCouldNotBeConfirmed', 'Stop could not be confirmed.')
        )
      }
    } catch (error) {
      setError(botFailureMessage(error) ?? String(error))
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
      setError(botFailureMessage(error) ?? String(error))
    } finally {
      setStartingThread(false)
    }
  }
  const memberFaces = (group?.members ?? []).flatMap((member) => {
    const bot = bots.find((bot) => bot.id === member.botId)
    return bot ? [{ id: bot.id, avatar: mobileBotAvatarSource(bot) }] : []
  })
  return (
    <View
      style={[
        styles.screen,
        {
          paddingTop: NATIVE_SCREEN_HEADER ? 0 : insets.top,
          paddingBottom: insets.bottom + keyboardLift
        }
      ]}
    >
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
      <ScreenHeader
        title={anyRoomGroup?.name ?? t('bots.groups.group', 'Group')}
        onBack={() => router.back()}
        actions={[
          ...(itemsOnPhone
            ? [
                {
                  id: 'items',
                  icon: ListChecks,
                  label: t('session.header.items', 'Items'),
                  onPress: () => setItemsOpen(true)
                }
              ]
            : []),
          {
            id: 'actions',
            icon: Ellipsis,
            label: t('bots.groups.groupActions', 'Group actions'),
            onPress: () => setMenu('actions')
          }
        ]}
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
      <MobileNativeChatComposerMenuHost style={styles.grow}>
        <MobileBotGroupTranscript client={client} roomId={roomId} data={data}>
          {data?.hasEarlier ? (
            <Pressable accessibilityRole="button" onPress={() => void loadEarlier()}>
              <Text style={styles.notice}>
                {t('bots.groups.loadEarlierMessages', 'Load earlier messages')}
              </Text>
            </Pressable>
          ) : null}
          {botGroupRoomOrder(data?.messages ?? []).map((message) => (
            <MobileBotGroupPost
              key={message.id}
              message={message}
              client={client}
              bots={bots}
              sessions={sessions}
              onStop={(botId) => void stop(botId)}
              onReply={(botId) => group && setDraft(botGroupReplyDraft(botId, draft, group, bots))}
            />
          ))}
        </MobileBotGroupTranscript>
        {group ? (
          <MobileBotGroupApprovalDock group={group} bots={bots} sessions={sessions} />
        ) : null}
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
          placeholder={t(
            'bots.groups.composerPlaceholder',
            'Message the group, @ to mention a bot'
          )}
          disabled={!connected}
          onAttachImage={attachPhotos}
          attachments={[...photos.images]}
          onRemoveAttachment={photos.remove}
          isAttaching={photos.uploading}
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
          sessionOptions={mobileBotGroupSessionOptions(chosen)}
          stop={working ? { held: false, onStop: () => void stop() } : null}
          onSend={async (text) => {
            if (!group) {
              return false
            }
            composerDraft.clearForSend(text)
            const sent = photos.images
            photos.clearSent(sent.map((image) => image.id))
            try {
              const result = groupSend.interpret(
                await groupSend.request(client, {
                  groupId,
                  revision: group.revision,
                  threadId,
                  messageId: randomV4Uuid(),
                  text,
                  ...(sent.length > 0 ? { images: sent.map((image) => image.path) } : {})
                })
              )
              apply({ kind: 'sent', message: result.message })
              setError(null)
              return true
            } catch (error) {
              composerDraft.restoreRefused(text)
              photos.returnRefused(sent)
              setError(botFailureMessage(error) ?? String(error))
              return false
            }
          }}
        />
      </MobileNativeChatComposerMenuHost>
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
          onDelete: group ? () => setMenu('delete') : null
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
      <MobileBotGroupDeleteConfirm
        client={client}
        hostId={hostId}
        group={menu === 'delete' ? (anyRoomGroup ?? null) : null}
        onClose={() => setMenu(null)}
        onDeleted={() => router.back()}
        onError={setError}
      />
      {itemsOnPhone ? (
        <MobileBotGroupItems
          visible={itemsOpen}
          onClose={() => setItemsOpen(false)}
          client={client}
          groupId={groupId}
          hostId={hostId}
          bots={bots}
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
          hostName={hostName}
          onClose={() => setMenu(null)}
          // The host's change refresh brings the new members with the rows their change rewrote.
          onSaved={() => setMenu(null)}
        />
      ) : null}
    </View>
  )
}
