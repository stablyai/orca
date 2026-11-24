// Whether this host holds the connector connection: only a host the cloud can bring work to does.
import { botHasConnector, type Bot } from '../../shared/bot-types'
import type { ConnectorTrigger } from '../../shared/connectors/connector-cloud-contract'

/** A bot on Slack, Linear or GitHub or shared with people, or a webhook rule the hello lists;
 *  other home-chat-only bots hear nothing. */
export function hostNeedsConnector(
  bots: readonly (Parameters<typeof botHasConnector>[0] & Pick<Bot, 'shares'>)[],
  triggers: readonly Pick<ConnectorTrigger, 'source'>[]
): boolean {
  return (
    bots.some((bot) => botHasConnector(bot) || (bot.shares?.length ?? 0) > 0) ||
    triggers.some((trigger) => trigger.source === 'webhook')
  )
}
