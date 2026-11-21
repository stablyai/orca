// Connectors' Linear, GitHub, Google and Composio pages and their setups, as the list opens them.
import { useEffect, type ReactNode } from 'react'
import { botLinearWorkspaces, type BotMember } from '../../../../src/shared/bot-types'
import { composioAppName } from '../../../../src/shared/composio/composio-curated-apps'
import type { BotUpdateParams } from '../../../../src/shared/rpc-contract/bots-params'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { MobileComposio } from '../../session/native-chat/transcript/bot-cards/mobile-composio-store'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import type { BotAccessRequests } from '../use-bot-access-requests'
import { githubOrgsOf } from './connector-account-rows'
import type { AccountConnectorPage, ConnectorPage } from './connector-pages'
import { MobileBotComposioConnect } from './MobileBotComposio'
import { MobileBotComposioApp } from './MobileBotComposioApp'
import { MobileBotGitHubPage } from './MobileBotGitHubPage'
import { MobileBotGitHubSetup } from './MobileBotGitHubSetup'
import { MobileBotGoogleConnect } from './MobileBotGoogleConnect'
import { MobileBotGooglePage, type PhoneGoogle } from './MobileBotGooglePage'
import { MobileBotLinearPage } from './MobileBotLinearPage'
import { MobileBotLinearSetup } from './MobileBotLinearSetup'
import type { useConnectorPeople } from './MobileConnectorAccountParts'
import type { PhoneGitHubView, PhoneLinearView } from './use-phone-connector-account'

export type AccountPagesContext = {
  client: RpcClient | null
  bot: PhoneBot
  accessBot: Parameters<typeof useConnectorPeople>[0]['accessBot']
  hostKey: string
  hostBots: readonly PhoneBot[]
  access: BotAccessRequests | null
  hostName: string
  online: boolean
  banner: ReactNode
  showToast: (message: string, durationMs?: number) => void
  save: (updates: BotUpdateParams['updates']) => Promise<boolean>
  removeMember: (member: BotMember) => void
  onAskInChat?: ((draft: string) => void) | null
  linear: { view: PhoneLinearView; refresh: () => Promise<void> }
  github: { view: PhoneGitHubView; refresh: () => Promise<void> }
  google: PhoneGoogle
  composio: MobileComposio
}

export function MobileBotConnectorAccountPage(
  props: AccountPagesContext & {
    page: AccountConnectorPage
    setPage: (page: ConnectorPage) => void
  }
) {
  const t = useMobileTranslation()
  const { page, setPage, bot } = props
  const list = () => setPage({ kind: 'list' })
  const github = props.github.view.status === 'ready' ? props.github.view.value : null
  const shown = githubOrgsOf(bot, github)
  const workspace =
    page.kind === 'linear'
      ? botLinearWorkspaces(bot).find((entry) => entry.workspaceId === page.workspaceId)
      : undefined
  const connection =
    page.kind === 'composio'
      ? props.composio.connections?.connections.find(
          (entry) => entry.app === page.app && entry.label === page.label
        )
      : undefined
  // A page whose connector went (removed here or elsewhere) goes back to the list.
  const gone =
    (page.kind === 'linear' && !workspace) ||
    // An org that left (removed, unlinked or unreadable) never turns into GitHub as a whole.
    (page.kind === 'github' &&
      page.installationId !== null &&
      props.github.view.status !== 'loading' &&
      !shown.some((entry) => entry.installationId === page.installationId)) ||
    (page.kind === 'composio' && props.composio.connections !== null && !connection)
  useEffect(() => {
    if (gone) {
      setPage({ kind: 'list' })
    }
  }, [gone, setPage])
  const scope = {
    client: props.client,
    bot,
    hostName: props.hostName,
    online: props.online,
    banner: props.banner,
    showToast: props.showToast
  }
  const people = {
    accessBot: props.accessBot,
    hostBots: props.hostBots,
    access: props.access,
    save: props.save,
    removeMember: props.removeMember
  }

  switch (page.kind) {
    case 'linear':
      return workspace ? (
        <MobileBotLinearPage
          {...scope}
          {...people}
          workspace={workspace}
          linear={props.linear}
          onBack={list}
          onSetUp={(workspaceId) => setPage({ kind: 'linear-setup', workspaceId, from: page })}
        />
      ) : null
    case 'linear-setup':
      return (
        <MobileBotLinearSetup
          {...scope}
          workspaceId={page.workspaceId}
          linear={props.linear}
          save={props.save}
          onClose={() => setPage(page.from)}
          onDone={(workspaceId) => setPage({ kind: 'linear', workspaceId })}
        />
      )
    case 'github':
      return (
        <MobileBotGitHubPage
          {...scope}
          {...people}
          installation={shown.find((entry) => entry.installationId === page.installationId) ?? null}
          github={props.github}
          onBack={list}
          onSetUp={() => setPage({ kind: 'github-setup', from: page })}
        />
      )
    case 'github-setup':
      return (
        <MobileBotGitHubSetup
          {...scope}
          github={props.github}
          save={props.save}
          onClose={() => setPage(page.from)}
          onDone={() => {
            props.showToast(
              t('bots.github.setup.isOn', '{{name}} is on GitHub', { name: bot.name })
            )
            setPage({ kind: 'github', installationId: shown[0]?.installationId ?? null })
          }}
        />
      )
    case 'google':
      return (
        <MobileBotGooglePage
          {...scope}
          google={props.google}
          onBack={list}
          onConnect={() => setPage({ kind: 'google-connect', from: page })}
        />
      )
    case 'google-connect': {
      const askInChat = props.onAskInChat
      return (
        <MobileBotGoogleConnect
          {...scope}
          google={props.google}
          onClose={() => setPage(page.from)}
          onOn={() => {
            props.showToast(t('bots.google.isOn', 'Google is on for {{name}}', { name: bot.name }))
            setPage({ kind: 'google' })
          }}
          // An empty draft opens the bot's chat as it is, where the setup's cards carry on.
          onOpenChat={askInChat ? () => askInChat('') : null}
        />
      )
    }
    case 'composio':
      return connection ? (
        <MobileBotComposioApp
          {...scope}
          botId={bot.id}
          botName={bot.name}
          hostKey={props.hostKey}
          composio={props.composio}
          connection={{ ...connection, name: composioAppName(connection.app, connection.name) }}
          onBack={list}
        />
      ) : null
    case 'composio-connect':
      return (
        <MobileBotComposioConnect
          {...scope}
          botId={bot.id}
          hostKey={props.hostKey}
          composio={props.composio}
          app={page.app}
          onClose={() => setPage(page.from)}
          onDone={() => {
            props.showToast(
              t('bots.composio.added', '{{bot}} can now use {{app}}', {
                bot: bot.name,
                app: page.app.name
              })
            )
            list()
          }}
        />
      )
  }
}
