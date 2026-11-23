import { useState } from 'react'
import {
  BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY,
  BOTS_AVATAR_OUTFIT_RUNTIME_CAPABILITY,
  BOTS_BACKUP_MODELS_RUNTIME_CAPABILITY
} from '../../../src/shared/bot-runtime-capabilities'
import type { BotUpdateParams } from '../../../src/shared/rpc-contract/bots-params'
import { UNSAVED_DRAFTS_REMOVAL_REFUSAL } from '../../../src/shared/worktree/removal/removal'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botAvatarUpload, botDelete, botUpdate } from './bot-sheet-operations'
import { MobileBotSettingsOffline } from './MobileBotSettingsOffline'
import { phoneAccessHost } from './bot-access-request-copy'
import type { BotAccessRequests } from './use-bot-access-requests'
import type { RouteBot } from './use-route-bot'
import { readConnectionStatusProbe } from '../transport/connection/runtime-status-probe'
import { useRouteCapability } from '../worktree/execution-hosts/use-route-capability'
import { useBackClaim } from '../navigation/use-back-claim'
import { isHostNotConnectedError } from '../query/host-query-errors'
import {
  MobileBotSettingsRoot,
  MobileBotStalePage,
  type BotSettingsTarget,
  type SettingsFeature,
  type SettingsRootPage
} from './MobileBotSettingsRoot'
import { MobileBotPermissionsPage } from './MobileBotPermissionsPage'
import { MobileBotIdentityPage } from './MobileBotIdentityPage'
import { MobileBotAgentPage } from './MobileBotAgentPage'
import { MobileBotBackupModelsPage } from './MobileBotBackupModelsPage'
import { MobileBotComputerPage } from './MobileBotComputerPage'
import { MobileBotWhoCanAskPage } from './MobileBotWhoCanAskPage'
import { ensureBotHomeChat } from './host-bots-read'
import { useMobileBotConnectorSettings } from './connectors/MobileBotConnectors'
import { useBotSoulMemorySkills } from './use-bot-soul-memory-skills'
import { useMobileBotSharingSettings } from './sharing/MobileBotSharing'
import { useBotSharedFromSettings } from './sharing/MobileBotSharedFrom'
import { botSaveErrorMessage } from './mobile-bot-sheet-copy'
import { useBotScheduleSettings } from './MobileBotScheduleSettings'
import { whoCanAskLine } from './bot-settings-lines'
import { DrillRow } from '../host-screen/workspace-options/workspace-option-rows'

/** Pages that claim Back themselves, for the pages they open. */
const OWN_BACK: readonly SettingsRootPage[] = ['tools', 'look-around', 'tidy-up', 'original']

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
  /** The bot's home folder on its computer (null until read), and where to go once Settings deletes it. */
  home: { folderPath: string | null; onDeleted: () => void }
  /** Puts a draft in the bot's Home Chat, where hooks are made; null while no chat shows. */
  onAskInChat?: ((draft: string) => void) | null
  onOpenFile?: (path: string) => void
  /** The page Settings opens on, read as it mounts; absent opens the list. */
  initialPage?: BotSettingsTarget
}) {
  const t = useMobileTranslation()
  const { bot, applyBot } = props.routeBot
  const status = props.client ? readConnectionStatusProbe(props.client) : undefined
  const takesColor = useRouteCapability(BOTS_AVATAR_COLOR_RUNTIME_CAPABILITY)
  const takesOutfit = useRouteCapability(BOTS_AVATAR_OUTFIT_RUNTIME_CAPABILITY)
  const takesBackupModels = useRouteCapability(BOTS_BACKUP_MODELS_RUNTIME_CAPABILITY)
  const accessBot = { ...bot, accessHost: phoneAccessHost(status) }
  const [saving, setSaving] = useState(false)
  const locked = saving || !props.online
  const offlineBanner = <MobileBotSettingsOffline hostName={props.hostName} client={props.client} />
  const [deleting, setDeleting] = useState(false)
  const [page, setPage] = useState(typeof props.initialPage === 'string' ? props.initialPage : null)
  const closePage = () => setPage(null)
  useBackClaim(
    page && !OWN_BACK.includes(page)
      ? () => {
          closePage()
          return true
        }
      : null
  )
  const access = props.accessRequests
  const sharing = useMobileBotSharingSettings(props, offlineBanner)
  const backToSettings = {
    label: t('bots.lookAround.back', 'Back to Settings'),
    onPress: closePage
  }

  const errorMessage = (error: unknown) => botSaveErrorMessage(error, props.hostName)

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
  const connectors = useMobileBotConnectorSettings(props, offlineBanner, {
    accessBot,
    save,
    initialPage: typeof props.initialPage === 'object' ? props.initialPage : undefined
  })
  const knows = useBotSoulMemorySkills(props, offlineBanner, page, setPage, save)
  const schedule = useBotScheduleSettings(props, {
    banner: offlineBanner,
    locked,
    page,
    setPage,
    save
  })
  const whoCanAsk: SettingsFeature = {
    rows: [
      {
        key: 'who-can-ask',
        group: 'access',
        node: (
          <DrillRow
            label={t('bots.settings.whoCanAsk', 'Who can ask')}
            value={whoCanAskLine(bot.members, access?.requests.length ?? 0)}
            detail
            onPress={() => setPage('who-can-ask')}
          />
        )
      }
    ],
    page:
      page === 'who-can-ask' ? (
        <MobileBotWhoCanAskPage
          {...props}
          bot={accessBot}
          access={access}
          locked={locked}
          banner={offlineBanner}
          onBack={backToSettings}
          save={save}
          setSaving={setSaving}
        />
      ) : null
  }
  // In the desktop's order within each group: Access is Connectors, Who can ask, Tools, then Skills.
  const sharedFrom = useBotSharedFromSettings(props, { banner: offlineBanner, page, setPage })
  const features = [sharedFrom, schedule, connectors, whoCanAsk, knows, sharing]

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

  const featurePage = features.find((feature) => feature.page)?.page
  if (featurePage) {
    return featurePage
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

  if (page === 'identity') {
    return (
      <MobileBotIdentityPage
        bot={bot}
        avatar={props.routeBot.avatar}
        takesColor={takesColor}
        takesOutfit={takesOutfit}
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
            await ensureBotHomeChat(props.client, bot.id).then(
              (refusal) => refusal && props.showToast(refusal, 3000)
            )
          }
        }}
      />
    )
  }
  if (page === 'backup-models') {
    return (
      <MobileBotBackupModelsPage
        bot={bot}
        client={props.client}
        online={props.online}
        disabled={locked}
        hostName={props.hostName}
        banner={offlineBanner}
        onBack={backToSettings}
        onSave={(backupModels) => save({ backupModels })}
        showToast={props.showToast}
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
  if (page === 'permissions') {
    return (
      <MobileBotPermissionsPage
        bot={bot}
        disabled={!props.online}
        banner={offlineBanner}
        onBack={backToSettings}
        onPick={(permissionMode) => {
          void save({ permissionMode })
          closePage()
        }}
      />
    )
  }
  return (
    <MobileBotSettingsRoot
      bot={bot}
      avatar={props.routeBot.avatar}
      hostName={props.hostName}
      online={props.online}
      locked={locked}
      open={setPage}
      setActive={(active) => void save({ paused: !active })}
      setNotification={(key, on) =>
        void save({ notifications: { ...bot.notifications, [key]: on } })
      }
      onDelete={() => setDeleting(true)}
      rows={features.flatMap((feature) => feature.rows)}
      takesBackupModels={takesBackupModels}
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
