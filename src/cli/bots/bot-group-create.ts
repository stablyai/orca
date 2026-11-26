// `orca bot group create --offer`: shows the owner a card proposing a group chat, which creates nothing
// until they press Create group. Groups are run by their owner, in Orca.
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { CommandHandler } from '../dispatch/dispatch'
import {
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callBots, findBot } from './bot'

export const BOT_GROUP_CREATE_HANDLERS: Record<string, CommandHandler> = {
  'bot group create': async ({ flags, client, json }) => {
    // Only the owner creates a group, in Orca; from the CLI a bot can only propose one.
    if (!flags.has('offer')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'A bot can’t create a group. Propose one with --offer; your owner creates it from the card.'
      )
    }
    const callerSessionId = readInjectedAgentSessionId()
    if (!callerSessionId) {
      throw new RuntimeClientError('invalid_argument', "Run this from a bot's chat.")
    }
    const name = getRequiredStringFlag(flags, 'name')
    const botIds: string[] = []
    for (const selector of getRepeatedStringFlag(flags, 'bot')) {
      botIds.push((await findBot(client, selector)).id)
    }
    const purpose = getOptionalStringFlag(flags, 'purpose')
    const result = await callBots<{ offered: boolean; message: string }>(
      client,
      'bots.groups.createOffer',
      {
        callerSessionId,
        name,
        botIds,
        ...(purpose ? { purpose } : {}),
        ...(flags.has('without-me') ? { withoutCaller: true } : {})
      }
    )
    printResult(result, json, (value) => value.message)
  }
}
