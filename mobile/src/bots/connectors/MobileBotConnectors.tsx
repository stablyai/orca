// Settings › Connectors: the desktop's BotConnectorsSection as a page inside the bot's settings, from the same
// list in its order: each Slack workspace, Linear workspace and GitHub org, Google, Webhooks, each app signed in
// through Composio, then the apps the bot has as tools.
import { useState, type ReactNode } from 'react'
import { Plus } from '../../components/icons/app-icons'
import { botLinearWorkspaces, botSlackApps } from '../../../../src/shared/bot-types'
import type { BotUpdateParams } from '../../../../src/shared/rpc-contract/bots-params'
import { ListRow, LIST_LEADING_INSET } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import {
  rereadMobileComposio,
  useMobileComposio
} from '../../session/native-chat/transcript/bot-cards/mobile-composio-store'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useHostBotsEntry } from '../host-bot-store'
import { memberRemoval } from '../bot-sheet-operations'
import type { PhoneBot } from '../host-bots-operations'
import type { BotAccessRequests } from '../use-bot-access-requests'
import { useMobileBotWebhookSettings } from '../webhooks/MobileBotWebhooks'
import { MobileBotConnectorsAddPage } from './MobileBotConnectorsAddPage'
import type { ConnectorPage } from './connector-pages'
import type { SettingsFeature } from '../MobileBotSettingsRoot'
import { MobileBotConnectorAccountPage } from './MobileBotConnectorAccountPages'
import { usePhoneGoogleStatus } from './phone-google-accounts'
import { usePhoneGitHubAccount, usePhoneLinearAccount } from './use-phone-connector-account'
import { connectorNames, connectorRows } from './connector-entry-rows'
import { MobileBotSlackPage } from './MobileBotSlackPage'
import { MobileBotSlackSetup } from './MobileBotSlackSetup'
import { otherSlackTeams } from '../../../../src/shared/bots/bot-slack-setup-teams'
import { usePhoneBotSlack } from './use-phone-bot-slack'
import { MobileBotConnectorToolPages } from './MobileBotConnectorToolPages'
import { useBotToolsPage } from '../tools/use-bot-tools-page'

type ConnectorsContext = {
  client: RpcClient | null
  routeBot: { reads: number; bot: PhoneBot; hostKey: string }
  showToast: (message: string, durationMs?: number) => void
  online: boolean
  hostName: string
  onAskInChat?: ((draft: string) => void) | null
  accessRequests: BotAccessRequests | null
}

/** What Slack's page needs from Settings: the bot shaped for the access confirm, and removing a person. */
type ConnectorsActions = {
  accessBot: Parameters<typeof MobileBotSlackPage>[0]['accessBot']
  /** Settings' own save: a connector's page stops one person asking, turns it on or removes it. */
  save: (updates: BotUpdateParams['updates']) => Promise<boolean>
  /** The page Connectors opens on, from outside Settings; read as it mounts. */
  initialPage?: ConnectorPage
}

type Page = ConnectorPage

/** The Settings row and, while open, the page that replaces Settings (or Webhooks, opened from it). */
export function useMobileBotConnectorSettings(
  settings: ConnectorsContext,
  banner: ReactNode,
  actions: ConnectorsActions
): SettingsFeature {
  const t = useMobileTranslation()
  // The page Connectors mounts on, while open.
  const [open, setOpen] = useState<ConnectorPage | null>(actions.initialPage ?? null)
  const webhooks = useMobileBotWebhookSettings(settings, banner)
  if (webhooks.page) {
    return { rows: [], page: webhooks.page }
  }
  const names = connectorNames(settings.routeBot.bot, webhooks.row !== null, t)
  const row = (
    <ListRow
      title={t('settings.bots.connectors', 'Connectors')}
      subtitle={names.length > 0 ? names.join(', ') : undefined}
      subtitleLines={1}
      navigates
      onPress={() => setOpen({ kind: 'list' })}
    />
  )
  return {
    // Access's first row, as on the desktop.
    rows: [{ key: 'connectors', group: 'access', node: row }],
    page: open ? (
      <ConnectorsPage
        {...settings}
        {...actions}
        banner={banner}
        webhooksRow={webhooks.row}
        initialPage={open}
        onBack={() => setOpen(null)}
      />
    ) : null
  }
}

function ConnectorsPage(
  props: ConnectorsContext &
    ConnectorsActions & { banner: ReactNode; webhooksRow: ReactNode; onBack: () => void }
) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { bot, reads, hostKey } = props.routeBot
  const [page, setPage] = useState<Page>(props.initialPage ?? { kind: 'list' })
  const list = () => setPage({ kind: 'list' })
  useBackClaim(
    page.kind === 'list'
      ? () => {
          props.onBack()
          return true
        }
      : null
  )
  const slackApps = botSlackApps(bot)
  const slack = usePhoneBotSlack(
    props.client,
    hostKey,
    bot.id,
    reads,
    slackApps.length > 0 || page.kind === 'slack-setup'
  )
  const linearPages = page.kind === 'linear' || page.kind === 'linear-setup'
  const linear = usePhoneLinearAccount(
    props.client,
    hostKey,
    botLinearWorkspaces(bot).length > 0 || linearPages,
    reads
  )
  const github = usePhoneGitHubAccount(
    props.client,
    hostKey,
    bot.github !== null ||
      page.kind === 'github' ||
      page.kind === 'github-setup' ||
      page.kind === 'add',
    reads
  )
  const google = usePhoneGoogleStatus(
    props.client,
    hostKey,
    bot.google === true || page.kind.startsWith('google'),
    reads
  )
  const composio = useMobileComposio(props.client, hostKey, bot.id)
  // Only the apps' URL servers are checked, as the desktop's Connectors does.
  const tools = useBotToolsPage(props.client, bot.id, 'apps', reads, hostKey)
  const hostBots = useHostBotsEntry(hostKey)?.bots ?? []
  const githubState = github.view.status === 'ready' ? github.view.value : null
  const githubInstallUrl = githubState?.installUrl ?? null

  if (page.kind === 'slack-setup') {
    return (
      <MobileBotSlackSetup
        client={props.client}
        botId={bot.id}
        botName={bot.name}
        teamId={page.teamId}
        inSlack={slackApps.length > 0}
        // The workspaces a later bot reuses: those other bots on this host are in.
        knownTeams={otherSlackTeams(hostBots, bot)}
        hostBots={hostBots}
        slack={slack}
        hostName={props.hostName}
        online={props.online}
        banner={props.banner}
        showToast={props.showToast}
        onClose={() => setPage(page.from)}
        onInstalled={(teamId) => setPage({ kind: 'slack', teamId })}
      />
    )
  }
  if (page.kind === 'slack') {
    return (
      <MobileBotSlackPage
        client={props.client}
        bot={bot}
        accessBot={props.accessBot}
        teamId={page.teamId}
        slack={slack}
        access={props.accessRequests}
        hostName={props.hostName}
        online={props.online}
        banner={props.banner}
        showToast={props.showToast}
        removeMember={(member) => void props.save(memberRemoval(member))}
        onBack={list}
        onSetUp={(teamId) => setPage({ kind: 'slack-setup', teamId, from: page })}
      />
    )
  }
  if (page.kind === 'tool' || page.kind === 'add-tool') {
    return (
      <MobileBotConnectorToolPages
        page={page}
        setPage={setPage}
        client={props.client}
        bot={bot}
        tools={tools}
        hostName={props.hostName}
        online={props.online}
        banner={props.banner}
        showToast={props.showToast}
      />
    )
  }
  if (page.kind !== 'list' && page.kind !== 'add') {
    return (
      <MobileBotConnectorAccountPage
        page={page}
        setPage={setPage}
        client={props.client}
        bot={bot}
        accessBot={props.accessBot}
        hostKey={hostKey}
        hostBots={hostBots}
        access={props.accessRequests}
        hostName={props.hostName}
        online={props.online}
        banner={props.banner}
        showToast={props.showToast}
        save={props.save}
        removeMember={(member) => void props.save(memberRemoval(member))}
        onAskInChat={props.onAskInChat}
        linear={linear}
        github={github}
        google={google}
        composio={composio}
      />
    )
  }
  if (page.kind === 'add') {
    return (
      <MobileBotConnectorsAddPage
        client={props.client}
        bot={bot}
        online={props.online}
        banner={props.banner}
        page={page}
        setPage={setPage}
        tools={tools}
        composio={composio}
        githubInstallUrl={githubInstallUrl}
        hasWebhooks={props.webhooksRow !== null}
        onAskInChat={props.onAskInChat}
      />
    )
  }

  const rows = connectorRows({
    bot,
    slack: slack.view,
    linear: linear.view,
    githubState,
    googleEmails: (google.status?.accounts ?? []).map((account) => account.email),
    composio,
    tools: tools.tools ? { own: tools.tools.own, problems: tools.problems } : null,
    webhooksRow: props.webhooksRow,
    rereadComposio: () => rereadMobileComposio(hostKey, bot.id),
    hostName: props.hostName,
    online: props.online,
    setPage,
    save: props.online ? props.save : null,
    t
  })
  return (
    <>
      <SheetHeader
        title={t('settings.bots.connectors', 'Connectors')}
        onBack={{ label: t('bots.lookAround.back', 'Back to Settings'), onPress: props.onBack }}
      />
      {props.banner}
      <SettingsSection first separatorInset={LIST_LEADING_INSET}>
        {rows}
        <ListRow
          key="add"
          leading={<Plus size={18} color={colors.textMuted} />}
          title={t('settings.bots.addConnector', 'Add a connector')}
          onPress={() => setPage({ kind: 'add' })}
        />
      </SettingsSection>
    </>
  )
}
