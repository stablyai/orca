// The reads behind Who can ask's lists: the agent's Slack, and the owner's Linear and GitHub links, the
// same answers Connectors and Needs you show.
import type { Translate } from '../i18n/mobile-i18n'
import { botLinearWorkspaces, botSlackApps } from '../../../src/shared/bot-types'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useReadsAtMostEveryMinute } from './connectors/phone-connector-reads'
import { usePhoneBotSlack } from './connectors/use-phone-bot-slack'
import {
  usePhoneGitHubAccount,
  usePhoneLinearAccount,
  type PhoneAccountView
} from './connectors/use-phone-connector-account'
import type { PhoneBot } from './host-bots-operations'
import { whoCanAskConnectors, type WhoCanAskConnector } from './who-can-ask-connectors'

const linkRead = <T>(view: PhoneAccountView<T>) => ({
  value: view.status === 'ready' ? view.value : null,
  checking: view.status === 'loading'
})

export function useWhoCanAskConnectors(
  client: RpcClient | null,
  bot: PhoneBot,
  route: { reads: number; hostKey: string },
  hostName: string,
  t: Translate
): WhoCanAskConnector[] {
  const { reads, hostKey } = route
  // The owner's links are an Orca Cloud call each: read as the page opens, then at most once a minute.
  const again = useReadsAtMostEveryMinute(reads)
  const slack = usePhoneBotSlack(client, hostKey, bot.id, reads, botSlackApps(bot).length > 0)
  const linear = usePhoneLinearAccount(client, hostKey, botLinearWorkspaces(bot).length > 0, again)
  const github = usePhoneGitHubAccount(client, hostKey, bot.github !== null, again)
  return whoCanAskConnectors({
    client,
    bot,
    hostName,
    t,
    slack,
    linear: linkRead(linear.view),
    github: linkRead(github.view)
  })
}
