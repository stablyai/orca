// The bot's connectors that need the owner, as Needs you lists them: the shared list's entries
// (bot-connector-entries) that need the owner, from the reads the Connectors page makes. Each opens
// the connector's own page in Settings › Connectors.
import { useEffect, useMemo, useState } from 'react'
import { botLinearWorkspaces, botSlackApps } from '../../../../src/shared/bot-types'
import { botConnectorTitleLine } from '../../../../src/shared/bots/bot-connector-titles'
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

/** Where a need is fixed; null for a tool app, whose sign-in the phone doesn't read here. */
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
    case 'webhooks':
    case 'app':
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
    const need =
      entry.kind === 'slack' && entry.updateNeeded
        ? t('settings.bots.slackStatus.updateNeeded', 'Update needed')
        : t('bots.needs.connector', '{{name}} needs you to sign in again or fix it.', {
            name: title
          })
    return [{ key: entry.key, title, need, page }]
  })
}

const READ_EVERY_MS = 60_000

/** The route's read count, moved on at most once a minute: each read is an Orca Cloud call on the
 *  host, and the route reads on every change of the bot's work. */
function useReadsAtMostEveryMinute(reads: number): number {
  const [passed, setPassed] = useState({ reads, at: 0 })
  useEffect(() => {
    const now = Date.now()
    if (reads !== passed.reads && now - passed.at >= READ_EVERY_MS) {
      setPassed({ reads, at: now })
    }
  }, [reads, passed])
  return passed.reads
}

/** The needs while `client` is set (the panel shows); the reads only the bot's connectors call for.
 *  Tool apps' sign-ins aren't read here, so they stay on the desktop for now. */
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
  const slack = usePhoneBotSlack(client, bot.id, again, shown && botSlackApps(bot).length > 0)
  const linear = usePhoneLinearAccount(client, shown && botLinearWorkspaces(bot).length > 0, again)
  const github = usePhoneGitHubAccount(client, shown && bot.github !== null, again)
  const google = usePhoneGoogleStatus(client, shown && bot.google === true, again)
  const composio = useMobileComposio(client, hostKey, bot.id)
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
          tools: null,
          hostName,
          t
        },
        google.status !== null,
        t
      ),
    [bot, slack.view, linear.view, github.view, google.status, composio, hostName, t]
  )
}
