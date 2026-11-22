// `orca bot composio …`: the bot asks Orca for its next Composio setup card.
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callBots } from './bot'

function callerSessionId(): string {
  const id = readInjectedAgentSessionId()
  if (!id) {
    throw new RuntimeClientError('invalid_argument', "Run this from a bot's chat.")
  }
  return id
}

export const BOT_COMPOSIO_HANDLERS: Record<string, CommandHandler> = {
  'bot composio events': async ({ client, flags, json }) => {
    const config = getOptionalStringFlag(flags, 'config')
    const result = await callBots<{ message: string }>(client, 'bots.composio.events', {
      callerSessionId: callerSessionId(),
      hookId: getRequiredStringFlag(flags, 'hook'),
      trigger: getRequiredStringFlag(flags, 'trigger'),
      ...(config ? { config } : {})
    })
    printResult(result, json, (value) => value.message)
  },
  'bot composio setup': async ({ client, flags, json }) => {
    const app = getOptionalStringFlag(flags, 'app')
    const name = getOptionalStringFlag(flags, 'name')
    const result = await callBots<{ card: string | null; message: string }>(
      client,
      'bots.composio.setup',
      { callerSessionId: callerSessionId(), ...(app ? { app } : {}), ...(name ? { name } : {}) }
    )
    printResult(result, json, (value) => value.message)
  }
}
