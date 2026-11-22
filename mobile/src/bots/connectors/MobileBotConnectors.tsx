// Settings › Connectors: the desktop's BotConnectorsSection as a page inside the bot's settings, in its order:
// each Slack workspace, each Linear workspace, GitHub, Google, Webhooks, then each app signed in through Composio.
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { Fragment, useCallback, useState, type ReactNode } from 'react'
import { Blocks, Plus } from 'lucide-react-native'
import { botLinearWorkspaces, botMembersFrom, botSlackApps } from '../../../../src/shared/bot-types'
import {
  COMPOSIO_CURATED_APPS,
  composioAppName
} from '../../../../src/shared/composio/composio-curated-apps'
import type { BotUpdateParams } from '../../../../src/shared/rpc-contract/bots-params'
import { ListRow, LIST_LEADING_INSET } from '../../components/list/ListGroup'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { openGitHubLink } from './connector-link'
import { useMobileComposio } from '../../session/native-chat/transcript/bot-cards/mobile-composio-store'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useHostBotsEntry } from '../host-bot-store'
import { memberRemoval } from '../bot-sheet-operations'
import type { PhoneBot } from '../host-bots-operations'
import type { BotAccessRequests } from '../use-bot-access-requests'
import { MobileConnectorSourceIcon, MobileGoogleMark } from '../MobileConnectorSourceIcon'
import { useMobileBotWebhookSettings } from '../webhooks/MobileBotWebhooks'
import { MobileBotAddConnector } from './MobileBotAddConnector'
import type { ConnectorPage } from './connector-pages'
import { MobileBotConnectorAccountPage } from './MobileBotConnectorAccountPages'
import { usePhoneGoogleStatus } from './MobileBotGooglePage'
import { usePhoneGitHubAccount, usePhoneLinearAccount } from './use-phone-connector-account'
import {
  connectorNames,
  connectorTitle,
  githubOrgsOf,
  linearGitHubRows
} from './connector-account-rows'
import { MobileBotSlackPage } from './MobileBotSlackPage'
import { MobileBotSlackSetup } from './MobileBotSlackSetup'
import { slackRowFace } from './mobile-slack-copy'
import { usePhoneBotSlack } from './use-phone-bot-slack'

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
}

type Page = ConnectorPage

const ICON = 20

/** The Settings row and, while open, the page that replaces Settings (or Webhooks, opened from it). */
export function useMobileBotConnectorSettings(
  settings: ConnectorsContext,
  banner: ReactNode,
  actions: ConnectorsActions
): { row: ReactNode; page: ReactNode } {
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  const webhooks = useMobileBotWebhookSettings(settings, banner)
  if (webhooks.page) {
    return { row: null, page: webhooks.page }
  }
  const names = connectorNames(settings.routeBot.bot, webhooks.row !== null, t)
  const row = (
    <ListRow
      title={t('settings.bots.connectors', 'Connectors')}
      subtitle={names.length > 0 ? names.join(', ') : undefined}
      subtitleLines={1}
      navigates
      onPress={() => setOpen(true)}
    />
  )
  return {
    row,
    page: open ? (
      <ConnectorsPage
        {...settings}
        {...actions}
        banner={banner}
        webhooksRow={webhooks.row}
        onBack={() => setOpen(false)}
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
  const { bot, reads } = props.routeBot
  const [page, setPage] = useState<Page>({ kind: 'list' })
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
  const slackPeople = botMembersFrom(bot.members, 'slack').length > 0
  const slack = usePhoneBotSlack(
    props.client,
    bot.id,
    reads,
    slackApps.length > 0 || page.kind === 'slack-setup'
  )
  const linearPages = page.kind === 'linear' || page.kind === 'linear-setup'
  const linear = usePhoneLinearAccount(
    props.client,
    botLinearWorkspaces(bot).length > 0 || linearPages,
    reads
  )
  const github = usePhoneGitHubAccount(
    props.client,
    bot.github !== null ||
      page.kind === 'github' ||
      page.kind === 'github-setup' ||
      page.kind === 'add',
    reads
  )
  const google = usePhoneGoogleStatus(
    props.client,
    bot.google === true || page.kind === 'google' || page.kind === 'google-connect',
    reads
  )
  const composio = useMobileComposio(props.client, props.routeBot.hostKey, bot.id)
  const hostBots = useHostBotsEntry(props.routeBot.hostKey)?.bots ?? []
  const githubState = github.view.status === 'ready' ? github.view.value : null
  const githubInstallUrl = githubState?.installUrl ?? null
  const githubOrgs = githubOrgsOf(bot, githubState)
  const { showToast } = props
  const onInstalled = useCallback(
    (teamId: string) => {
      setPage({ kind: 'slack', teamId })
      showToast(t('bots.slack.setup.isIn', '{{name}} is in Slack', { name: bot.name }))
    },
    [showToast, t, bot.name]
  )
  const signIns = (composio.connections?.connections ?? []).filter(
    // A sign-in still under way finishes in the browser.
    (connection) => connection.status !== 'pending'
  )

  if (page.kind === 'slack-setup') {
    const from = page.from
    return (
      <MobileBotSlackSetup
        client={props.client}
        botId={bot.id}
        botName={bot.name}
        teamId={page.teamId}
        inSlack={slackApps.length > 0}
        // The workspace a later bot reuses: one another bot on this host is in.
        knownTeam={
          hostBots.find((other) => other.id !== bot.id && other.slack)?.slack?.teamId ?? null
        }
        slack={slack}
        hostName={props.hostName}
        online={props.online}
        banner={props.banner}
        onClose={() => setPage(from)}
        onInstalled={onInstalled}
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
  if (page.kind !== 'list' && page.kind !== 'add') {
    return (
      <MobileBotConnectorAccountPage
        page={page}
        setPage={setPage}
        client={props.client}
        bot={bot}
        accessBot={props.accessBot}
        hostKey={props.routeBot.hostKey}
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
    const manage = list
    const setUpSlack = (teamId: string | undefined) =>
      setPage({ kind: 'slack-setup', teamId, from: page })
    const askInChat = props.onAskInChat
    return (
      <MobileBotAddConnector
        botName={bot.name}
        disabled={!props.online}
        banner={props.banner}
        onBack={list}
        options={[
          {
            id: 'slack',
            added: slackApps.length > 0,
            addAnother: () => setUpSlack(undefined),
            add: () => setUpSlack(undefined),
            manage
          },
          {
            id: 'github',
            added: bot.github !== null,
            // Another org: GitHub's install page, where the owner picks it, as the desktop does.
            ...(githubInstallUrl ? { addAnother: () => openGitHubLink(githubInstallUrl) } : {}),
            add: () => setPage({ kind: 'github-setup', from: page }),
            manage
          },
          {
            id: 'linear',
            added: botLinearWorkspaces(bot).length > 0,
            addAnother: () => setPage({ kind: 'linear-setup', workspaceId: undefined, from: page }),
            add: () => setPage({ kind: 'linear-setup', workspaceId: undefined, from: page }),
            manage
          },
          {
            id: 'google',
            added: bot.google === true,
            add: () => setPage({ kind: 'google-connect', from: page }),
            manage
          },
          {
            id: 'webhooks',
            added: props.webhooksRow !== null,
            // As the desktop: the bot sets hooks up with you in chat.
            ...(askInChat
              ? { add: () => askInChat(t('bots.webhooks.setUpDraft', 'Set up a webhook that ')) }
              : {}),
            manage
          }
        ]}
        composio={{
          curated: COMPOSIO_CURATED_APPS,
          active: signIns
            .filter((connection) => connection.status === 'active')
            .map((connection) => connection.app),
          catalog: composio.status?.key === 'ok' ? { client: props.client, botId: bot.id } : null,
          onPick: (app) => {
            // Signed in already: Manage opens the app's page, as the desktop does.
            const active = signIns.find(
              (connection) => connection.app === app.slug && connection.status === 'active'
            )
            setPage(
              active
                ? { kind: 'composio', app: active.app, label: active.label }
                : { kind: 'composio-connect', app, from: page }
            )
          }
        }}
      />
    )
  }

  const googleEmails = (google.status?.accounts ?? []).map((account) => account.email)
  const mark = (source: 'slack' | 'linear' | 'github') => (
    <MobileConnectorSourceIcon source={source} size={ICON} />
  )
  const rows: ReactNode[] = []
  for (const app of slackApps) {
    const face = slackRowFace(slack.view, app.teamId, props.hostName, t)
    rows.push(
      <ListRow
        key={`slack:${app.teamId}`}
        leading={mark('slack')}
        title={connectorTitle(BOT_CONNECTOR_NAMES.slack, face.workspace, t)}
        subtitle={face.description}
        subtitleLines={1}
        value={face.status?.label}
        navigates
        onPress={() => setPage({ kind: 'slack', teamId: app.teamId })}
      />
    )
  }
  // People added in Slack stay listed after its app is removed, so they can be removed too.
  if (slackApps.length === 0 && slackPeople) {
    rows.push(
      <ListRow
        key="slack"
        leading={mark('slack')}
        title={BOT_CONNECTOR_NAMES.slack}
        navigates
        onPress={() => setPage({ kind: 'slack', teamId: undefined })}
      />
    )
  }
  rows.push(
    ...linearGitHubRows({
      bot,
      linear: linear.view,
      githubOrgs,
      githubState,
      setPage,
      save: props.online ? props.save : null,
      t
    })
  )
  if (bot.google === true) {
    rows.push(
      <ListRow
        key="google"
        leading={<MobileGoogleMark size={ICON} />}
        title={BOT_CONNECTOR_NAMES.google}
        subtitle={googleEmails.length > 0 ? googleEmails.join(', ') : undefined}
        subtitleLines={1}
        navigates
        onPress={() => setPage({ kind: 'google' })}
      />
    )
  }
  if (props.webhooksRow) {
    rows.push(<Fragment key="webhooks">{props.webhooksRow}</Fragment>)
  }
  for (const connection of signIns) {
    rows.push(
      <ListRow
        key={`composio:${connection.app}:${connection.label ?? ''}`}
        leading={<Blocks size={ICON} color={colors.textSecondary} />}
        title={composioAppName(connection.app, connection.name)}
        subtitle={
          connection.status === 'active'
            ? [connection.label, t('bots.composio.viaComposio', 'via Composio')]
                .filter(Boolean)
                .join(' · ')
            : t('bots.composio.signedOut', 'Signed out · {{via}}', {
                via: t('bots.composio.viaComposio', 'via Composio')
              })
        }
        subtitleLines={1}
        navigates
        onPress={() => setPage({ kind: 'composio', app: connection.app, label: connection.label })}
      />
    )
  }
  const openAdd = () => setPage({ kind: 'add' })
  return (
    <>
      <SheetHeader
        title={t('settings.bots.connectors', 'Connectors')}
        onBack={{ label: t('bots.lookAround.back', 'Back to Settings'), onPress: props.onBack }}
        trailingButtons={
          <NavBarButton
            icon={Plus}
            accessibilityLabel={t('settings.bots.addConnector', 'Add a connector')}
            onPress={openAdd}
          />
        }
      />
      {props.banner}
      {rows.length > 0 ? (
        <SettingsSection first separatorInset={LIST_LEADING_INSET}>
          {rows}
        </SettingsSection>
      ) : (
        <SettingsNote>
          {t(
            'bots.connectors.emptyNote',
            'Let people reach {{name}} in Slack, GitHub and Linear, and let it work in your Google and other apps.',
            { name: bot.name }
          )}
        </SettingsNote>
      )}
      <SettingsSection separatorInset={LIST_LEADING_INSET}>
        <ListRow
          leading={<Plus size={ICON} color={colors.textPrimary} />}
          title={t('settings.bots.addConnector', 'Add a connector')}
          onPress={openAdd}
        />
      </SettingsSection>
    </>
  )
}
