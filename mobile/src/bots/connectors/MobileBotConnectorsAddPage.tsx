// Connectors › Add a connector: what Connectors knows of the bot, as the Add page's options.
import type { ReactNode } from 'react'
import { botLinearWorkspaces, botSlackApps } from '../../../../src/shared/bot-types'
import { isBotAppTool } from '../../../../src/shared/bots/bot-connector-entries'
import { botMcpAppUrl } from '../../../../src/shared/bots/bot-mcp-apps'
import { COMPOSIO_CURATED_APPS } from '../../../../src/shared/composio/composio-curated-apps'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { useMobileComposio } from '../../session/native-chat/transcript/bot-cards/mobile-composio-store'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import type { useBotToolsPage } from '../tools/use-bot-tools-page'
import { openGitHubLink } from './connector-link'
import type { ConnectorPage } from './connector-pages'
import { MobileBotAddConnector } from './MobileBotAddConnector'

export function MobileBotConnectorsAddPage(props: {
  client: RpcClient | null
  bot: PhoneBot
  online: boolean
  banner: ReactNode
  page: Extract<ConnectorPage, { kind: 'add' }>
  setPage: (page: ConnectorPage) => void
  /** The bot's app tools, as Connectors read them. */
  tools: ReturnType<typeof useBotToolsPage>
  composio: ReturnType<typeof useMobileComposio>
  /** GitHub's install page, where the owner picks another org. */
  githubInstallUrl: string | null
  hasWebhooks: boolean
  onAskInChat?: ((draft: string) => void) | null
}) {
  const t = useMobileTranslation()
  const list = () => props.setPage({ kind: 'list' })
  const signIns = (props.composio.connections?.connections ?? []).filter(
    // A sign-in still under way finishes in the browser.
    (connection) => connection.status !== 'pending'
  )
  // As the desktop's Add to <bot>: only a URL server counts as the app, never a command of its name.
  const appTools = (props.tools.tools?.own ?? []).filter(isBotAppTool)
  const setUpSlack = (teamId: string | undefined) =>
    props.setPage({ kind: 'slack-setup', teamId, from: props.page })
  const askInChat = props.onAskInChat
  const installUrl = props.githubInstallUrl
  return (
    <MobileBotAddConnector
      botName={props.bot.name}
      disabled={!props.online}
      banner={props.banner}
      onBack={list}
      options={[
        {
          id: 'slack',
          added: botSlackApps(props.bot).length > 0,
          addAnother: () => setUpSlack(undefined),
          add: () => setUpSlack(undefined),
          manage: list
        },
        {
          id: 'github',
          added: props.bot.github !== null,
          // Another org: GitHub's install page, where the owner picks it, as the desktop does.
          ...(installUrl ? { addAnother: () => openGitHubLink(installUrl) } : {}),
          add: () => props.setPage({ kind: 'github-setup', from: props.page }),
          manage: list
        },
        {
          id: 'linear',
          added: botLinearWorkspaces(props.bot).length > 0,
          addAnother: () =>
            props.setPage({ kind: 'linear-setup', workspaceId: undefined, from: props.page }),
          add: () =>
            props.setPage({ kind: 'linear-setup', workspaceId: undefined, from: props.page }),
          manage: list
        },
        {
          id: 'google',
          added: props.bot.google === true,
          add: () => props.setPage({ kind: 'google-connect', from: props.page }),
          manage: list
        },
        {
          id: 'webhooks',
          added: props.hasWebhooks,
          // As the desktop: the bot sets hooks up with you in chat.
          ...(askInChat
            ? { add: () => askInChat(t('bots.webhooks.setUpDraft', 'Set up a webhook that ')) }
            : {}),
          manage: list
        }
      ]}
      composio={{
        curated: COMPOSIO_CURATED_APPS,
        active: signIns
          .filter((connection) => connection.status === 'active')
          .map((connection) => connection.app),
        catalog:
          props.composio.status?.key === 'ok'
            ? { client: props.client, botId: props.bot.id }
            : null,
        onPick: (app) => {
          // Signed in already: Manage opens the app's page, as the desktop does.
          const active = signIns.find(
            (connection) => connection.app === app.slug && connection.status === 'active'
          )
          props.setPage(
            active
              ? { kind: 'composio', app: active.app, label: active.label }
              : { kind: 'composio-connect', app, from: props.page }
          )
        }
      }}
      apps={{
        added: new Set(appTools.map((tool) => tool.name)),
        onPick: (app) => {
          const onBot = appTools.some((tool) => tool.name === app.id)
          // Its address shows before Add; a blank in it (a site or host) starts at its default.
          props.setPage(
            onBot
              ? { kind: 'tool', name: app.id, signIn: false }
              : {
                  kind: 'add-tool',
                  preset: { source: botMcpAppUrl(app), name: app.id },
                  from: props.page
                }
          )
        },
        onAddByUrl: () => props.setPage({ kind: 'add-tool', from: props.page })
      }}
    />
  )
}
