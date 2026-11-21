// Settings › Connectors: the desktop's BotConnectorsSection as a page inside the bot's settings, in its order:
// each Slack workspace, each Linear workspace, GitHub, Google, Webhooks, then each app signed in through Composio.
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { Blocks, Plus } from 'lucide-react-native'
import { botLinearWorkspaces, botMembersFrom, botSlackApps } from '../../../../src/shared/bot-types'
import { composioAppName } from '../../../../src/shared/composio/composio-curated-apps'
import { ListRow, LIST_LEADING_INSET } from '../../components/list/ListGroup'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { hostReadClient } from '../../query/host-read-client'
import { googleStatusRead } from '../../session/native-chat/transcript/bot-cards/mobile-bot-card-operations'
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
  /** Settings' own save, which Slack's page uses to stop one person asking. */
  save: (updates: ReturnType<typeof memberRemoval>) => unknown
}

type Page =
  | { kind: 'list' }
  | { kind: 'add' }
  /** No team: a bot whose app was removed but whose Slack people remain. */
  | { kind: 'slack'; teamId: string | undefined }
  /** `from`: where Cancel returns. */
  | { kind: 'slack-setup'; teamId: string | undefined; from: Page }

const ICON = 20

function title(service: string, place: string | null | undefined, t: Translate): string {
  return place ? `${service}${t('bots.connector.titleSeparator', ' · ')}${place}` : service
}

const linearAddress = (urlKey: string): string => `linear.app/${urlKey}`

/** The services the bot's own record says it has, for the Settings row. */
function connectorNames(bot: PhoneBot, hasHooks: boolean, t: Translate): string[] {
  return [
    (botSlackApps(bot).length > 0 || botMembersFrom(bot.members, 'slack').length > 0) &&
      BOT_CONNECTOR_NAMES.slack,
    botLinearWorkspaces(bot).length > 0 && BOT_CONNECTOR_NAMES.linear,
    bot.github !== null && BOT_CONNECTOR_NAMES.github,
    bot.google === true && BOT_CONNECTOR_NAMES.google,
    hasHooks && t('bots.webhooks.name', 'Webhooks')
  ].filter((name): name is string => typeof name === 'string')
}

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

/** The host's Google accounts' addresses, read while the page shows a bot that uses Google. */
function useGoogleEmails(client: RpcClient | null, enabled: boolean, again: number): string[] {
  const [emails, setEmails] = useState<string[]>([])
  useEffect(() => {
    if (!client || !enabled) {
      return
    }
    let current = true
    void googleStatusRead
      .request(hostReadClient(client), {})
      .then((reply) => {
        if (current) {
          setEmails((googleStatusRead.interpret(reply).accounts ?? []).map((a) => a.email))
        }
      })
      // Unread, the row keeps what it showed.
      .catch(() => {})
    return () => {
      current = false
    }
  }, [client, enabled, again])
  return emails
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
  const googleEmails = useGoogleEmails(props.client, bot.google === true, reads)
  const composio = useMobileComposio(props.client, props.routeBot.hostKey, bot.id)
  const hostBots = useHostBotsEntry(props.routeBot.hostKey)?.bots ?? []
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
          { id: 'github', added: bot.github !== null, manage },
          { id: 'linear', added: botLinearWorkspaces(bot).length > 0, manage },
          { id: 'google', added: bot.google === true, manage },
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
      />
    )
  }

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
        title={title(BOT_CONNECTOR_NAMES.slack, face.workspace, t)}
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
  for (const workspace of botLinearWorkspaces(bot)) {
    rows.push(
      <ListRow
        key={`linear:${workspace.workspaceId}`}
        leading={mark('linear')}
        title={title(BOT_CONNECTOR_NAMES.linear, workspace.workspaceName, t)}
        subtitle={workspace.urlKey ? linearAddress(workspace.urlKey) : undefined}
        subtitleLines={1}
      />
    )
  }
  if (bot.github) {
    rows.push(<ListRow key="github" leading={mark('github')} title={BOT_CONNECTOR_NAMES.github} />)
  }
  if (bot.google === true) {
    rows.push(
      <ListRow
        key="google"
        leading={<MobileGoogleMark size={ICON} />}
        title={BOT_CONNECTOR_NAMES.google}
        subtitle={googleEmails.length > 0 ? googleEmails.join(', ') : undefined}
        subtitleLines={1}
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
        title={composioAppName(connection.app)}
        subtitle={[connection.label, t('bots.composio.viaComposio', 'via Composio')]
          .filter(Boolean)
          .join(' · ')}
        subtitleLines={1}
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
