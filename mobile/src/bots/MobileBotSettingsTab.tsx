import { useState } from 'react'
import { View } from 'react-native'
import { AGENT_CHAT_PERMISSION_MODES } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModes } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-support'
import { botMemberSource, type BotMember } from '../../../src/shared/bot-types'
import { accessRequestPerson } from '../../../src/shared/bots/bot-access-request'
import type { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'
import type { BotUpdateParams } from '../../../src/shared/rpc-contract/bots-params'
import type { BotLookAround } from '../../../src/shared/bots/bot-look-around'
import type { BotTidyUp } from '../../../src/shared/bots/bot-tidy-up'
import { agentChatPermissionModeCopy } from '../../../src/shared/agent-session/options/permissions/structured-agent-session-permission-option'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  ChoiceRows,
  DrillRow,
  SwitchRow
} from '../host-screen/workspace-options/workspace-option-rows'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botUpdate, removeEveryoneWhoCanAsk } from './bot-sheet-operations'
import { MobileBotTextButton } from './MobileBotTextButton'
import { MobileBotSettingsOffline } from './MobileBotSettingsOffline'
import { SettingsNote, SettingsSection as Section } from '../settings/settings-screen-frame'
import {
  MobileLookAroundPage,
  MobileLookAroundSection,
  type LookAroundPage
} from './MobileBotLookAround'
import { MobileTidyUpPage, MobileTidyUpSection, type TidyUpPage } from './MobileBotTidyUp'
import { useMobileBotTidyUp } from './use-mobile-bot-tidy-up'
import { BOT_ACCESS_COPY, botAccessCopy } from '../../../src/shared/bots/bot-access-copy'
import {
  accessGrantConfirmCopy,
  accessRequestLine,
  phoneAccessHost
} from './bot-access-request-copy'
import type { BotAccessRequests } from './use-bot-access-requests'
import type { RouteBot } from './use-route-bot'
import { readConnectionStatusProbe } from '../transport/connection/runtime-status-probe'
import { useBackClaim } from '../navigation/use-back-claim'
import { ListRow } from '../components/list/ListGroup'
import { optionStyles } from './mobile-bot-option-styles'
import {
  MobileAccessFixConfirm,
  MobileBotMemberRow,
  MobileBotWhoCanAsk
} from './MobileBotWhoCanAsk'
import { isHostNotConnectedError } from '../query/host-query-errors'

// What the host lets a phone change.
type PhoneUpdates = Pick<
  BotUpdateParams['updates'],
  'paused' | 'permissionMode' | 'notifications' | 'removeMember' | 'lookAround' | 'tidyUp'
>

function AccessRequestRow(props: {
  request: ConnectorAccessRequest
  disabled: boolean
  onDecline: () => void
  onReview: () => void
}) {
  const t = useMobileTranslation()
  const person = accessRequestPerson(props.request)
  return (
    <ListRow
      title={person}
      subtitle={accessRequestLine(props.request)}
      accessory={
        <View style={optionStyles.rowActions}>
          <MobileBotTextButton
            label={BOT_ACCESS_COPY.decline}
            accessibilityLabel={t('bots.settings.declineName', 'Decline {{name}}', {
              name: person
            })}
            disabled={props.disabled}
            onPress={props.onDecline}
          />
          <MobileBotTextButton
            label={BOT_ACCESS_COPY.review}
            accessibilityLabel={t('bots.settings.reviewName', 'Review {{name}}', { name: person })}
            disabled={props.disabled}
            onPress={props.onReview}
          />
        </View>
      }
    />
  )
}

/** The phone's quick, reversible bot settings; the rest stay in the desktop's Settings › Bots. */
export function MobileBotSettingsTab(props: {
  routeBot: RouteBot
  client: RpcClient | null
  showToast: (message: string, durationMs?: number) => void
  /** Null without a route bot. */
  accessRequests: BotAccessRequests | null
  /** Null for an agent that can't look around. */
  lookAround: { onLookNow: () => void; busy: boolean } | null
  /** Settings as a page of its own, headed with a back to where it opened from; absent as a tab. */
  onBack?: { label: string; onPress: () => void }
  /** The host answers: off, every setting is read-only. */
  online: boolean
  hostName: string
}) {
  const t = useMobileTranslation()
  const { bot, applyBot } = props.routeBot
  const status = props.client ? readConnectionStatusProbe(props.client) : undefined
  const accessBot = { ...bot, accessHost: phoneAccessHost(status) }
  const [saving, setSaving] = useState(false)
  const locked = saving || !props.online
  const offlineBanner = <MobileBotSettingsOffline hostName={props.hostName} client={props.client} />
  const [removing, setRemoving] = useState<BotMember | null>(null)
  const [granting, setGranting] = useState<ConnectorAccessRequest | null>(null)
  const [fixing, setFixing] = useState<'only-me' | 'ask-for-approval' | null>(null)
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  useBackClaim(() => {
    if (!permissionsOpen) {
      return false
    }
    setPermissionsOpen(false)
    return true
  })
  const [lookPage, setLookPage] = useState<LookAroundPage | null>(null)
  const [tidyPage, setTidyPage] = useState<TidyUpPage | null>(null)
  const tidyUp = useMobileBotTidyUp(props.client, bot.id, props.routeBot.reads, props.showToast)
  const access = props.accessRequests

  const save = async (updates: PhoneUpdates) => {
    if (!props.client) {
      return
    }
    setSaving(true)
    try {
      const reply = botUpdate.interpret(
        await botUpdate.request(
          props.client,
          { botId: bot.id, updates },
          { failWhenDisconnected: true }
        )
      )
      applyBot(reply.bot)
    } catch (error) {
      props.showToast(
        isHostNotConnectedError(error)
          ? t('bots.items.write.offline', '{{host}} is offline.', { host: props.hostName })
          : error instanceof Error
            ? error.message
            : t('bots.saveFailed', 'Couldn’t save'),
        1800
      )
    } finally {
      setSaving(false)
    }
  }

  if (removing) {
    return (
      <ConfirmContent
        title={t('bots.settings.removeConfirmTitle', 'Remove {{name}}?', { name: removing.name })}
        message={t(
          'bots.settings.removeConfirmMessage',
          '{{name}} can no longer ask {{botName}}.',
          {
            name: removing.name,
            botName: bot.name
          }
        )}
        confirmLabel={t('bots.settings.remove', 'Remove')}
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const member = removing
          setRemoving(null)
          void save({
            removeMember: {
              id: member.id,
              source: botMemberSource(member),
              ...(member.workspaceId ? { workspaceId: member.workspaceId } : {})
            }
          })
        }}
      />
    )
  }

  const keepOnlyMe = async (client: RpcClient) => {
    setSaving(true)
    const failed = await removeEveryoneWhoCanAsk(client, bot, applyBot)
    setSaving(false)
    if (failed.length > 0) {
      props.showToast(botAccessCopy('fixOnlyMeFailed', { names: failed.join(', ') }), 2400)
    }
  }
  if (fixing) {
    return (
      <MobileAccessFixConfirm
        fix={fixing}
        bot={bot}
        onCancel={() => setFixing(null)}
        onConfirm={() => {
          setFixing(null)
          if (fixing === 'ask-for-approval') {
            void save({ permissionMode: 'ask' })
          } else if (props.client) {
            void keepOnlyMe(props.client)
          }
        }}
      />
    )
  }
  const saveLookAround = (lookAround: Partial<BotLookAround>) => void save({ lookAround })
  const saveTidyUp = (change: Partial<BotTidyUp>) => void save({ tidyUp: change })
  if (tidyPage && props.lookAround) {
    return (
      <MobileTidyUpPage
        page={tidyPage}
        bot={bot}
        view={tidyUp.view}
        busy={tidyUp.busy}
        disabled={!props.online}
        banner={offlineBanner}
        save={saveTidyUp}
        onUndo={tidyUp.undo}
        onBack={() => setTidyPage(null)}
      />
    )
  }
  if (lookPage && props.lookAround) {
    return (
      <MobileLookAroundPage
        page={lookPage}
        bot={bot}
        save={saveLookAround}
        onBack={() => setLookPage(null)}
        disabled={!props.online}
        banner={offlineBanner}
      />
    )
  }

  // Any paired phone may grant (D3), so it always asks first, as the desktop does.
  if (granting && access) {
    const copy = accessGrantConfirmCopy(granting, accessBot)
    return (
      <ConfirmContent
        title={copy.title}
        message={copy.message}
        confirmLabel={BOT_ACCESS_COPY.confirm}
        destructive
        onCancel={() => setGranting(null)}
        onConfirm={() => void access.decide(granting, 'granted')}
      />
    )
  }

  const modes = agentChatPermissionModes(bot.agent)?.modes ?? AGENT_CHAT_PERMISSION_MODES
  const inherit = t('bots.settings.sameAsChats', 'Same as chats')
  const permissionChoices = [
    {
      id: 'inherit',
      label: inherit,
      description: t('bots.settings.sameAsChatsDetail', 'Uses your chat permission setting.')
    },
    ...modes.map((mode) => ({ id: mode, ...agentChatPermissionModeCopy(bot.agent, mode) }))
  ]
  if (permissionsOpen) {
    return (
      <>
        <SheetHeader
          title={t('bots.settings.permissions', 'Permissions')}
          onBack={{
            label: t('bots.lookAround.back', 'Back to Settings'),
            onPress: () => setPermissionsOpen(false)
          }}
        />
        {offlineBanner}
        <ChoiceRows
          choices={permissionChoices}
          selected={bot.permissionMode ?? 'inherit'}
          disabled={!props.online}
          onSelect={(mode) => {
            if (mode === 'inherit' || modes.some((value) => value === mode)) {
              void save({
                permissionMode: mode === 'inherit' ? null : modes.find((value) => value === mode)!
              })
              setPermissionsOpen(false)
            }
          }}
        />
        <SettingsNote>
          {t(
            'bots.settings.permissionsDetail',
            'The starting permission for new sessions. Anything beyond it asks in the session.'
          )}
        </SettingsNote>
      </>
    )
  }
  const notify = (key: keyof typeof bot.notifications) => (value: boolean) =>
    void save({ notifications: { ...bot.notifications, [key]: value } })
  return (
    <>
      {props.onBack ? (
        <SheetHeader title={t('bots.sheet.settings', 'Settings')} onBack={props.onBack} />
      ) : null}
      {offlineBanner}
      <Section title={t('bots.settings.general', 'General')}>
        <SwitchRow
          label={t('bots.settings.active', 'Active')}
          detail={t('bots.settings.activeDetail', 'Answers messages and runs automations.')}
          value={!bot.paused}
          disabled={locked}
          onChange={(active) => void save({ paused: !active })}
        />
        <DrillRow
          label={t('bots.settings.permissions', 'Permissions')}
          value={
            bot.permissionMode
              ? agentChatPermissionModeCopy(bot.agent, bot.permissionMode).label
              : inherit
          }
          disabled={locked}
          onPress={() => setPermissionsOpen(true)}
        />
      </Section>
      {props.lookAround ? (
        <MobileLookAroundSection
          bot={bot}
          upNext={props.routeBot.activity?.upNext}
          disabled={locked || props.lookAround.busy}
          save={saveLookAround}
          onOpen={setLookPage}
          onLookNow={props.lookAround.onLookNow}
        />
      ) : null}
      {props.lookAround ? (
        <MobileTidyUpSection
          bot={bot}
          view={tidyUp.view}
          disabled={locked || tidyUp.busy}
          save={saveTidyUp}
          onOpen={setTidyPage}
          onTidyNow={tidyUp.tidyNow}
        />
      ) : null}
      {access && access.requests.length > 0 ? (
        <Section title={BOT_ACCESS_COPY.heading}>
          {access.requests.map((request) => (
            <AccessRequestRow
              key={request.requestId}
              request={request}
              disabled={access.deciding || !props.online}
              onDecline={() => void access.decide(request, 'declined')}
              onReview={() => setGranting(request)}
            />
          ))}
        </Section>
      ) : null}
      <MobileBotWhoCanAsk
        bot={accessBot}
        disabled={locked}
        onKeepOnlyMe={() => setFixing('only-me')}
        onAskForApproval={() => setFixing('ask-for-approval')}
      >
        {bot.members.map((member) => (
          <MobileBotMemberRow
            key={`${botMemberSource(member)}:${member.workspaceId ?? ''}:${member.id}`}
            member={member}
            disabled={locked}
            onRemove={() => setRemoving(member)}
          />
        ))}
      </MobileBotWhoCanAsk>
      {/* The desktop's order: general, then who can ask (connectors), then notifications. */}
      <Section title={t('bots.settings.notifications', 'Notifications')}>
        <SwitchRow
          label={t('bots.settings.needsPermission', 'Needs permission')}
          detail={t(
            'bots.settings.needsPermissionDetail',
            'When it or a worker needs your approval.'
          )}
          value={bot.notifications.needsPermission}
          disabled={locked}
          onChange={notify('needsPermission')}
        />
        <SwitchRow
          label={t('bots.settings.taskComplete', 'Task complete')}
          detail={t('bots.settings.taskCompleteDetail', 'A thread, automation or worker finishes.')}
          value={bot.notifications.taskComplete}
          disabled={locked}
          onChange={notify('taskComplete')}
        />
        <SwitchRow
          label={t('bots.settings.couldNotFinish', 'Couldn’t finish')}
          detail={t('bots.settings.couldNotFinishDetail', 'An automation run or worker fails.')}
          value={bot.notifications.couldNotFinish}
          disabled={locked}
          onChange={notify('couldNotFinish')}
        />
      </Section>
    </>
  )
}
