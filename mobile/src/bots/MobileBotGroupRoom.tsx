import { MobileBotGroupTranscript } from './MobileBotGroupTranscript'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileBotGroupReader, MobileBotGroupTurn } from './MobileBotGroupTurns'
import { useCallback, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronLeft, Ellipsis } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useHostProtocolGates } from '../components/host-connection/host-protocol-gates-context'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { colors } from '../theme/mobile-theme'
import { isBotAgent } from '../../../src/shared/bot-types'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import { botGroupReplyDraft } from '../../../src/shared/bots/bot-group-mentions'
import { useMobileBotGroupComposer } from './use-mobile-bot-group-composer'
import { confirmMobileBotGroupDelete } from './mobile-bot-group-delete'
import { MobileBotGroupPeerRequestLine } from './MobileBotGroupPeerRequestLine'
import { groupSend, groupStop, groupUpdate } from './bot-group-operations'
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
import { MobileNativeChatPermission } from '../session/native-chat/input/prompts/MobileNativeChatPermission'
import { MobileNativeChatQuestion } from '../session/native-chat/input/prompts/MobileNativeChatQuestion'
import { useMobileBotGroupDraft } from './use-mobile-bot-group-draft'

export function MobileBotGroupRoom({
  client,
  groupId,
  hostId,
  visible = true
}: {
  client: RpcClient
  groupId: string
  hostId: string
  visible?: boolean
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
  const composerDraft = useMobileBotGroupDraft(hostId, groupId)
  const { text: draft, edit: setDraft } = composerDraft
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<'actions' | 'members' | 'replies' | 'approvals' | null>(null)
  const [sessions, setSessions] = useState<ReadonlyMap<string, MobileBotGroupSession>>(new Map())
  const [approvalBot, setApprovalBot] = useState<string | null>(null)
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
  const { data, apply, bots, loadEarlier } = useMobileBotGroupTranscript(
    client,
    groupId,
    hostId,
    visible,
    setError
  )
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
  const defaultId = group?.replyMode.kind === 'bot' ? group.replyMode.botId : null
  const { recipientId, roomMentions, audience } = useMobileBotGroupComposer(group, bots, draft)
  const selectedMember = group?.members.find((member) => member.botId === recipientId)
  const chosen = selectedMember && sessions.get(selectedMember.sessionId)
  const waiting =
    group?.members.filter((member) => {
      const session = sessions.get(member.sessionId)
      return session?.permission || session?.question
    }) ?? []
  const requestMember = waiting.find((member) => member.botId === approvalBot) ?? waiting[0]
  const request = requestMember && sessions.get(requestMember.sessionId)
  const stop = async (botId?: string) => {
    try {
      const result = groupStop.interpret(await groupStop.request(client, { groupId, botId }))
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
  const choose = async (replyMode: BotGroup['replyMode']) => {
    if (!group) {
      return
    }
    try {
      const result = groupUpdate.interpret(
        await groupUpdate.request(client, { groupId, revision: group.revision, replyMode })
      )
      apply({ kind: 'group', group: result.group })
      setMenu(null)
    } catch (error) {
      setError(String(error))
    }
  }
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
        />
      ))}
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('bots.groups.back', 'Back')}
          onPress={() => router.back()}
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {group?.name ?? t('bots.groups.group', 'Group')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('bots.groups.groupActions', 'Group actions')}
          onPress={() => setMenu('actions')}
        >
          <Ellipsis size={22} color={colors.textPrimary} />
        </Pressable>
      </View>
      <MobileBotGroupTranscript groupId={groupId} hasItems={Boolean(data?.messages.length)}>
        {data?.hasEarlier ? (
          <Pressable accessibilityRole="button" onPress={() => void loadEarlier()}>
            <Text style={styles.notice}>
              {t('bots.groups.loadEarlierMessages', 'Load earlier messages')}
            </Text>
          </Pressable>
        ) : null}
        {data?.messages.map((message) => (
          <View key={message.id}>
            {message.author.kind === 'owner' ? (
              <MobileNativeChatMessage
                message={{
                  id: message.id,
                  role: 'user',
                  blocks: [{ type: 'text', text: message.text }],
                  timestamp: message.createdAt,
                  source: 'transcript'
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
      {request && requestMember ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('bots.groups.pendingRequests', 'Pending requests')}
            onPress={() => setMenu('approvals')}
          >
            <Text style={styles.notice}>
              {bots.find((bot) => bot.id === requestMember.botId)?.name}{' '}
              {t('bots.groups.needsYou', '· Needs you')}
              {waiting.length > 1
                ? t('bots.groups.valuePending', ' · {{value0}} pending', {
                    value0: waiting.length
                  })
                : ''}
            </Text>
          </Pressable>
          {request.permission ? (
            <MobileNativeChatPermission
              permission={request.permission}
              onRespond={request.respondPermission}
              onCancel={request.cancelPrompt}
            />
          ) : request.question ? (
            <MobileNativeChatQuestion
              question={request.question}
              onAnswer={request.respondQuestion}
              onCancel={request.cancelPrompt}
            />
          ) : null}
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.notice}>
          {error}
        </Text>
      ) : null}
      <MobileNativeChatComposer
        value={draft}
        onChangeText={setDraft}
        draftScopeKey={composerDraft.key}
        sendSurfaceId={`group:${groupId}`}
        getSendCompletionGeneration={() => 0}
        getComposerEditGeneration={composerDraft.getEditGeneration}
        agent={readers.find((turn) => turn.sessionId === selectedMember?.sessionId)?.agent}
        placeholder={t('bots.groups.composerPlaceholder', 'Message the group, @ to mention a bot')}
        roomMentions={roomMentions}
        roomReplies={
          <ModelPill
            primary={t('bots.groups.repliesValue', 'Replies: {{value0}}', { value0: audience })}
            secondary={null}
            warning={false}
            accessibleName={t('bots.groups.repliesValue', 'Replies: {{value0}}', {
              value0: audience
            })}
            disabled={!group}
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
        actions={[
          {
            label: t('bots.groups.manageMembersMenu', 'Manage members…'),
            onPress: () => setMenu('members'),
            skipAutoClose: true
          },
          ...(group
            ? [
                {
                  label: t('bots.groups.deleteGroupMenu', 'Delete group…'),
                  destructive: true,
                  onPress: () =>
                    confirmMobileBotGroupDelete({
                      client,
                      group,
                      t,
                      onDeleted: () => {
                        composerDraft.retire()
                        router.back()
                      },
                      onError: setError
                    })
                }
              ]
            : [])
        ]}
        onClose={() => setMenu(null)}
      />
      <ActionSheetModal
        visible={menu === 'replies'}
        title={t('bots.groups.whoAnswers', 'Who answers your messages')}
        actions={[
          ...bots
            .filter((bot) => group?.members.some((member) => member.botId === bot.id))
            .map((bot) => ({
              label: bot.name,
              checked: defaultId === bot.id,
              onPress: () => void choose({ kind: 'bot', botId: bot.id }),
              skipAutoClose: true
            })),
          {
            label: t('bots.groups.allBots', 'All bots'),
            checked: group?.replyMode.kind === 'all',
            onPress: () => void choose({ kind: 'all' }),
            skipAutoClose: true
          },
          {
            label: t('bots.groups.onlyWhenMentioned', 'Only when mentioned'),
            checked: group?.replyMode.kind === 'mentions',
            onPress: () => void choose({ kind: 'mentions' }),
            skipAutoClose: true
          }
        ]}
        onClose={() => setMenu(null)}
      />
      <ActionSheetModal
        visible={menu === 'approvals'}
        title={t('bots.groups.pendingRequests', 'Pending requests')}
        actions={waiting.map((member) => ({
          label: bots.find((bot) => bot.id === member.botId)?.name ?? 'Bot',
          onPress: () => setApprovalBot(member.botId)
        }))}
        onClose={() => setMenu(null)}
      />
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
