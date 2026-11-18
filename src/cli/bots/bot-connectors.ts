// `orca bot connectors [--offer <source>]`: what a bot can use where, or a Connect card for its owner.
import { OFFER_SOURCES } from '../../shared/bots/bot-connector-offer'
import { formatBotConnectors, type BotConnectorsView } from '../../shared/bots/bot-connectors-view'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callBots } from './bot'

export const BOT_CONNECTORS_HANDLERS: Record<string, CommandHandler> = {
  'bot connectors': async ({ flags, client, json }) => {
    const callerSessionId = readInjectedAgentSessionId()
    if (!callerSessionId) {
      throw new RuntimeClientError('invalid_argument', "Run this from a bot's chat.")
    }
    const offer = getOptionalStringFlag(flags, 'offer')
    const workspace = getOptionalStringFlag(flags, 'workspace')
    if (offer === undefined) {
      if (workspace) {
        throw new RuntimeClientError('invalid_argument', '--workspace goes with --offer.')
      }
      const view = await callBots<BotConnectorsView>(client, 'bots.connectors', {
        callerSessionId
      })
      printResult(view, json, formatBotConnectors)
      return
    }
    const source = OFFER_SOURCES.find((entry) => entry === offer)
    if (!source) {
      throw new RuntimeClientError('invalid_argument', `Offer one of: ${OFFER_SOURCES.join(', ')}`)
    }
    const result = await callBots<{ offered: boolean; message: string }>(
      client,
      'bots.connector.offer',
      { callerSessionId, source, ...(workspace ? { workspace } : {}) }
    )
    printResult(result, json, (value) => value.message)
  }
}
