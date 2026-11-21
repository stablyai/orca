import { useState } from 'react'
import { AGENT_CHAT_PERMISSION_MODES } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModes } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-support'
import { BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY } from '../../../src/shared/bot-runtime-capabilities'
import type { BotUpdateParams } from '../../../src/shared/rpc-contract/bots-params'
import { lookAroundSupported, type BotLookAround } from '../../../src/shared/bots/bot-look-around'
import type { BotTidyUp } from '../../../src/shared/bots/bot-tidy-up'
import { UNSAVED_DRAFTS_REMOVAL_REFUSAL } from '../../../src/shared/worktree/removal/removal'
import { agentChatPermissionModeCopy } from '../../../src/shared/agent-session/options/permissions/structured-agent-session-permission-option'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ChoiceRows } from '../host-screen/workspace-options/workspace-option-rows'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botAvatarUpload, botDelete, botUpdate } from './bot-sheet-operations'
import { MobileBotSettingsOffline } from './MobileBotSettingsOffline'
import { SettingsNote } from '../settings/settings-screen-frame'
import {
  MobileLookAroundPage,
  MobileLookAroundSection,
  type LookAroundPage
} from './MobileBotLookAround'
import { MobileTidyUpPage, MobileTidyUpSection, type TidyUpPage } from './MobileBotTidyUp'
import { useMobileBotTidyUp } from './use-mobile-bot-tidy-up'
import { phoneAccessHost } from './bot-access-request-copy'
import type { BotAccessRequests } from './use-bot-access-requests'
import type { RouteBot } from './use-route-bot'
import { readConnectionStatusProbe } from '../transport/connection/runtime-status-probe'
import { useBackClaim } from '../navigation/use-back-claim'
import { isHostNotConnectedError } from '../query/host-query-errors'
import {
  MobileBotSettingsRoot,
  MobileBotStalePage,
  type SettingsRootPage
} from './MobileBotSettingsRoot'
import { MobileBotIdentityPage } from './MobileBotIdentityPage'
import { MobileBotAgentPage } from './MobileBotAgentPage'
import { MobileBotComputerPage } from './MobileBotComputerPage'
import { MobileBotWhoCanAskPage } from './MobileBotWhoCanAskPage'
import { ensureBotHomeChat } from './host-bots-read'
import { useMobileBotConnectorSettings } from './connectors/MobileBotConnectors'
import { MobileBotToolsPage, MobileBotToolsRow } from './tools/MobileBotToolsPage'

/** The bot's home folder on its computer (null until read), and where to go once Settings deletes it. */
export type BotSettingsHome = { folderPath: string | null; onDeleted: () => void }

/** The bot's Settings, as the desktop's: one list, and a page for each row that has more. */
export function MobileBotSettingsTab(props: {
  routeBot: RouteBot
  client: RpcClient | null
  showToast: (message: string, durationMs?: number) => void
  /** Null without a route bot. */
  accessRequests: BotAccessRequests | null
  /** Look now, for an agent that looks around. */
  upNext: { lookNow: () => void; busy: boolean }
  /** Settings as a page of its own, headed with a back to where it opened from; absent as a tab. */
  onBack?: { label: string; onPress: () => void }
  /** The host answers: off, every setting is read-only. */
  online: boolean
  hostName: string
  home: BotSettingsHome
  /** Puts a draft in the bot's Home Chat, where hooks are made; null while no chat shows. */
  onAskInChat?: ((draft: string) => void) | null
}) {
  const t = useMobileTranslation()
  const { bot, applyBot } = props.routeBot
  const status = props.client ? readConnectionStatusProbe(props.client) : undefined
  const accessBot = { ...bot, accessHost: phoneAccessHost(status) }
  const [saving, setSaving] = useState(false)
  const locked = saving || !props.online
  const offlineBanner = <MobileBotSettingsOffline hostName={props.hostName} client={props.client} />
  const [deleting, setDeleting] = useState(false)
  const [page, setPage] = useState<SettingsRootPage | null>(null)
  // A page drilled into from Look around or Memory upkeep; its Back returns there.
  const [lookPage, setLookPage] = useState<LookAroundPage | null>(null)
  const [tidyPage, setTidyPage] = useState<TidyUpPage | null>(null)
  const closePage = () => setPage(null)
  useBackClaim(
    // Tools claims Back itself, for the pages it opens.
    page && page !== 'tools' && !lookPage && !tidyPage
      ? () => {
          closePage()
          return true
        }
      : null
  )
  const tidyUp = useMobileBotTidyUp(props.client, bot.id, props.routeBot.reads, props.showToast)
  const access = props.accessRequests
  const lookAround = lookAroundSupported(bot.agent) ? props.upNext : null
  const backToSettings = {
    label: t('bots.lookAround.back', 'Back to Settings'),
    onPress: closePage
  }

  const errorMessage = (error: unknown): string =>
    isHostNotConnectedError(error)
      ? t('bots.items.write.offline', '{{host}} is offline.', { host: props.hostName })
      : error instanceof Error && error.message === 'bot_name_taken'
        ? t('bots.settings.nameTaken', 'Another bot already has that name.')
        : error instanceof Error && error.message === 'bot_avatar_invalid'
          ? t('bots.picture.invalid', 'That picture could not be used. Pick a PNG or JPG image.')
          : error instanceof Error
            ? error.message
            : t('bots.saveFailed', 'Couldn’t save')

  const save = async (updates: BotUpdateParams['updates']): Promise<boolean> => {
    if (!props.client) {
      return false
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
      return true
    } catch (error) {
      props.showToast(errorMessage(error), 1800)
      return false
    } finally {
      setSaving(false)
    }
  }
  const connectors = useMobileBotConnectorSettings(props, offlineBanner, { accessBot, save })

  const upload = async (png: string): Promise<boolean> => {
    if (!props.client) {
      return false
    }
    try {
      const reply = botAvatarUpload.interpret(
        await botAvatarUpload.request(
          props.client,
          { botId: bot.id, png },
          { failWhenDisconnected: true }
        )
      )
      applyBot(reply.bot)
      return true
    } catch (error) {
      props.showToast(errorMessage(error), 1800)
      return false
    }
  }

  const deleteBot = async (client: RpcClient) => {
    setSaving(true)
    try {
      botDelete.interpret(
        await botDelete.request(client, { botId: bot.id }, { failWhenDisconnected: true })
      )
      props.home.onDeleted()
    } catch (error) {
      props.showToast(
        isHostNotConnectedError(error)
          ? errorMessage(error)
          : error instanceof Error && error.message === UNSAVED_DRAFTS_REMOVAL_REFUSAL
            ? t(
                'bots.settings.deleteUnsavedDrafts',
                'Its folder has unsaved editor changes. Save or close them on {{host}}, then delete again.',
                { host: props.hostName }
              )
            : t('bots.settings.deleteFailed', 'Something went wrong. Try again.'),
        1800
      )
    } finally {
      setSaving(false)
    }
  }

  if (connectors.page) {
    return connectors.page
  }

  if (deleting) {
    return (
      <ConfirmContent
        title={t('bots.settings.deleteTitle', 'Delete {{name}}?', { name: bot.name })}
        message={
          props.home.folderPath
            ? t(
                'bots.settings.deleteDetail',
                'Its folder stays at {{path}}, with its soul and memory.',
                { path: props.home.folderPath }
              )
            : t(
                'bots.settings.deleteDetailNoPath',
                'Its folder stays on {{host}}, with its soul and memory.',
                { host: props.hostName }
              )
        }
        confirmLabel={t('bots.settings.deleteConfirm', 'Delete bot')}
        destructive
        onCancel={() => setDeleting(false)}
        onConfirm={() => props.client && void deleteBot(props.client)}
      />
    )
  }

  const saveLookAround = (lookAround: Partial<BotLookAround>) => void save({ lookAround })
  const saveTidyUp = (change: Partial<BotTidyUp>) => void save({ tidyUp: change })
  if (page === 'tidy-up' && tidyPage && lookAround) {
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
  if (page === 'look-around' && lookPage && lookAround) {
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
  if (page === 'look-around' && lookAround) {
    return (
      <>
        <SheetHeader title={t('bots.lookAround.title', 'Look around')} onBack={backToSettings} />
        {offlineBanner}
        <MobileLookAroundSection
          bot={bot}
          upNext={props.routeBot.activity?.upNext}
          disabled={locked || lookAround.busy}
          save={saveLookAround}
          onOpen={setLookPage}
          onLookNow={lookAround.lookNow}
        />
      </>
    )
  }
  if (page === 'tidy-up' && lookAround) {
    return (
      <>
        <SheetHeader title={t('bots.tidyUp.title', 'Memory upkeep')} onBack={backToSettings} />
        {offlineBanner}
        <MobileTidyUpSection
          bot={bot}
          view={tidyUp.view}
          disabled={locked || tidyUp.busy}
          save={saveTidyUp}
          onOpen={setTidyPage}
          onTidyNow={tidyUp.tidyNow}
        />
      </>
    )
  }
  if (page === 'identity') {
    return (
      <MobileBotIdentityPage
        bot={bot}
        avatar={props.routeBot.avatar}
        takesColor={status?.capabilities?.includes(BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY) === true}
        disabled={!props.online}
        banner={offlineBanner}
        onCancel={closePage}
        onSave={save}
        onUpload={upload}
        showToast={props.showToast}
      />
    )
  }
  if (page === 'agent') {
    return (
      <MobileBotAgentPage
        bot={bot}
        client={props.client}
        online={props.online}
        disabled={locked}
        banner={offlineBanner}
        onBack={backToSettings}
        onLaunch={(launch) => void save({ launch })}
        onSwitch={async (agent) => {
          // The Home Chat starts fresh now, not on its next message, as the desktop's switch does.
          if ((await save({ agent, launch: null })) && props.client) {
            await ensureBotHomeChat(props.client, bot.id)
          }
        }}
      />
    )
  }
  if (page === 'computer') {
    return (
      <MobileBotComputerPage
        client={props.client}
        online={props.online}
        hostName={props.hostName}
        folderPath={props.home.folderPath}
        banner={offlineBanner}
        showToast={props.showToast}
        onBack={backToSettings}
      />
    )
  }
  if (page === 'stale') {
    return (
      <MobileBotStalePage
        stale={bot.itemsStale}
        disabled={locked}
        banner={offlineBanner}
        onBack={backToSettings}
        onPick={(itemsStale) => {
          void save({ itemsStale })
          closePage()
        }}
      />
    )
  }
  if (page === 'tools') {
    return <MobileBotToolsPage {...props} bot={bot} onBack={closePage} />
  }
  if (page === 'who-can-ask') {
    return (
      <MobileBotWhoCanAskPage
        bot={accessBot}
        client={props.client}
        access={access}
        online={props.online}
        locked={locked}
        banner={offlineBanner}
        onBack={backToSettings}
        save={save}
        applyBot={applyBot}
        setSaving={setSaving}
        showToast={props.showToast}
      />
    )
  }

  const modes = agentChatPermissionModes(bot.agent)?.modes ?? AGENT_CHAT_PERMISSION_MODES
  if (page === 'permissions') {
    const permissionChoices = [
      {
        id: 'inherit',
        label: t('bots.settings.sameAsChats', 'Same as chats'),
        description: t('bots.settings.sameAsChatsDetail', 'Uses your chat permission setting.')
      },
      ...modes.map((mode) => ({ id: mode, ...agentChatPermissionModeCopy(bot.agent, mode) }))
    ]
    return (
      <>
        <SheetHeader
          title={t('bots.settings.permissions', 'Permissions')}
          onBack={backToSettings}
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
              closePage()
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
  return (
    <MobileBotSettingsRoot
      bot={bot}
      avatar={props.routeBot.avatar}
      hostName={props.hostName}
      online={props.online}
      locked={locked}
      schedule={
        lookAround
          ? {
              lastLookedAt: props.routeBot.activity?.upNext?.state.lastLookedAt,
              tidyView: tidyUp.view
            }
          : null
      }
      accessRequests={access?.requests.length ?? 0}
      open={setPage}
      setActive={(active) => void save({ paused: !active })}
      setNotification={(key, on) =>
        void save({ notifications: { ...bot.notifications, [key]: on } })
      }
      onDelete={() => setDeleting(true)}
      connectorsRow={connectors.row}
      accessRows={<MobileBotToolsRow {...props} bot={bot} onOpen={() => setPage('tools')} />}
      header={
        <>
          {props.onBack ? (
            <SheetHeader title={t('bots.sheet.settings', 'Settings')} onBack={props.onBack} />
          ) : null}
          {offlineBanner}
        </>
      }
    />
  )
}
