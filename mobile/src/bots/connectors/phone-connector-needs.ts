// The bot's connectors that need the owner, as Needs you lists them: the shared list's entries
// (bot-connector-entries) that need the owner, from the reads the Connectors page shares. Each opens
// the connector's own page in Settings › Connectors.
import { useMemo } from 'react'
import { botLinearWorkspaces, botSlackApps } from '../../../../src/shared/bot-types'
import { botConnectorTitleLine } from '../../../../src/shared/bots/bot-connector-titles'
import { botToolSignInFace } from '../../../../src/shared/bots/bot-tool-sign-in-face'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileComposio } from '../../session/native-chat/transcript/bot-cards/mobile-composio-store'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import {
  phoneConnectorEntries,
  type PhoneConnectorEntry,
  type PhoneConnectorSources
} from './connector-entry-rows'
import type { ConnectorPage } from './connector-pages'
import { usePhoneGoogleStatus } from './MobileBotGooglePage'
import { useReadsAtMostEveryMinute } from './phone-connector-reads'
import { botToolSignInNeed } from '../tools/bot-tool-words'
import { useSharedBotTools } from '../tools/use-bot-tools-page'
import { usePhoneBotSlack } from './use-phone-bot-slack'
import { usePhoneGitHubAccount, usePhoneLinearAccount } from './use-phone-connector-account'

export type PhoneConnectorNeed = {
  key: string
  /** The connector's row title, e.g. "Slack · Stably". */
  title: string
  /** What it needs, in the desktop's words. */
  need: string
  page: ConnectorPage
}

/** Where a need is fixed: the connector's page, as the desktop's Open {{name}} opens its row. */
function needPage(entry: PhoneConnectorEntry): ConnectorPage | null {
  switch (entry.kind) {
    case 'slack':
      return { kind: 'slack', teamId: entry.teamId }
    case 'linear':
      return { kind: 'linear', workspaceId: entry.linear.workspaceId }
    case 'github':
      return { kind: 'github', installationId: entry.installation?.installationId ?? null }
    case 'google':
      return { kind: 'google' }
    case 'composio':
      return { kind: 'composio', app: entry.connection.app, label: entry.connection.label }
    case 'composio-problem':
      return entry.problem === 'key' ? { kind: 'composio-key' } : { kind: 'list' }
    case 'app':
      return { kind: 'tool', name: entry.tool.name, signIn: false }
    case 'webhooks':
      return null
  }
}

/** The entries that need the owner; Google only once read, as Connectors lists it before then. */
export function phoneConnectorNeeds(
  sources: PhoneConnectorSources,
  googleRead: boolean,
  t: Translate
): PhoneConnectorNeed[] {
  const separator = t('bots.connector.titleSeparator', ' · ')
  return phoneConnectorEntries(sources).flatMap((entry) => {
    const page = needPage(entry)
    if (!entry.needsOwner || !page || (entry.kind === 'google' && !googleRead)) {
      return []
    }
    const title = botConnectorTitleLine(entry.title, separator)
    const signIn =
      entry.kind === 'app'
        ? botToolSignInNeed(
            botToolSignInFace(entry.tool, entry.problem, false, undefined),
            t,
            title
          )
        : null
    const need =
      entry.kind === 'slack' && entry.updateNeeded
        ? t('settings.bots.slackStatus.updateNeeded', 'Update needed')
        : (signIn ??
          t('bots.needs.connector', '{{name}} needs you to sign in again or fix it.', {
            name: title
          }))
    return [{ key: entry.key, title, need, page }]
  })
}

/** The needs while `client` is set (the panel shows); the reads only the bot's connectors call for,
 *  and a tool app's sign-in from the last check Connectors ran. */
export function usePhoneConnectorNeeds({
  client,
  bot,
  reads,
  hostKey,
  hostName
}: {
  client: RpcClient | null
  bot: PhoneBot
  reads: number
  hostKey: string
  hostName: string
}): PhoneConnectorNeed[] {
  const t = useMobileTranslation()
  const shown = client !== null
  const again = useReadsAtMostEveryMinute(reads)
  const slack = usePhoneBotSlack(
    client,
    hostKey,
    bot.id,
    again,
    shown && botSlackApps(bot).length > 0
  )
  const linear = usePhoneLinearAccount(
    client,
    hostKey,
    shown && botLinearWorkspaces(bot).length > 0,
    again
  )
  const github = usePhoneGitHubAccount(client, hostKey, shown && bot.github !== null, again)
  const google = usePhoneGoogleStatus(client, hostKey, shown && bot.google === true, again)
  const composio = useMobileComposio(client, hostKey, bot.id)
  const tools = useSharedBotTools(client, hostKey, bot.id, shown, again)
  return useMemo(
    () =>
      phoneConnectorNeeds(
        {
          bot,
          slack: slack.view,
          linear: linear.view,
          githubState: github.view.status === 'ready' ? github.view.value : null,
          googleEmails: (google.status?.accounts ?? []).map((account) => account.email),
          composio,
          tools,
          hostName,
          t
        },
        google.status !== null,
        t
      ),
    [bot, slack.view, linear.view, github.view, google.status, composio, tools, hostName, t]
  )
}
