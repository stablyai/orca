import type { Bot } from '../../shared/bot-types'
import {
  BOT_ROSTER_COMMANDS,
  type BotRosterClient,
  type BotRosterEntry,
  formatBotRosterEntry,
  formatPairedClient,
  formatUnreachableBotServer
} from '../../shared/bot-roster'
import type { BotConnectors } from '../../shared/bot-event-sources'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callerChat } from '../automations/automation-caller-chat'
import { formatBotChats, type BotChatsResult } from './bot-chats-format'
import { orcaCloudNeedsSignIn } from '../../shared/bots/host-orca-sign-in'

export function formatBot(bot: Bot): string {
  return `${bot.name} (${bot.agent}${bot.paused ? ', paused' : ''})  id: ${bot.id}`
}

export function callBots<TResult>(
  client: HandlerContext['client'],
  method: string,
  params?: Record<string, unknown>
) {
  // An absent params key, not `undefined`, keeps a params-less method's request shape.
  return params === undefined ? client.call<TResult>(method) : client.call<TResult>(method, params)
}

/** bots.list; webhooks says whether the host's Orca Cloud takes webhooks, absent without one;
 *  connectorStatus 'signed-out' or 'needs-sign-in' that the host isn't signed in to Orca Cloud. */
export type BotsListResult = {
  bots: Bot[]
  webhooks?: boolean
  threadReplies: boolean
  githubEvents2?: boolean
  githubWorkflows?: boolean
  githubCiFinished?: boolean
  connectorStatus?: string
  /** The host's name when it is a headless Orca server; null with a window; absent from an older host. */
  signInServer?: string | null
}

/** The bot, with what its host's Orca Cloud takes. */
export type HostBot = Bot &
  Pick<
    BotConnectors,
    | 'webhooks'
    | 'cloudSignedOut'
    | 'signInServer'
    | 'githubEvents2'
    | 'githubWorkflows'
    | 'githubCiFinished'
  > & {
    threadReplies: boolean
  }

/** The bot named by id or name (any case), with what its host's Orca Cloud takes. */
export async function findBot(
  client: HandlerContext['client'],
  selector: string
): Promise<HostBot> {
  const { result } = await callBots<BotsListResult>(client, 'bots.list')
  const key = selector.toLowerCase()
  const bot =
    result.bots.find((entry) => entry.id === selector) ??
    result.bots.find((entry) => entry.name.toLowerCase() === key)
  if (!bot) {
    throw new RuntimeClientError('invalid_argument', `No bot named ${selector}`)
  }
  return {
    ...bot,
    webhooks: result.webhooks,
    threadReplies: result.threadReplies,
    githubEvents2: result.githubEvents2 === true,
    githubWorkflows: result.githubWorkflows === true,
    githubCiFinished: result.githubCiFinished === true,
    cloudSignedOut: orcaCloudNeedsSignIn(result.connectorStatus),
    ...(result.signInServer !== undefined ? { signInServer: result.signInServer } : {})
  }
}

export const BOT_HANDLERS: Record<string, CommandHandler> = {
  'bot new-chat': async ({ flags, client, json }) => {
    const selector = getOptionalStringFlag(flags, 'bot')
    const botId = selector ? (await findBot(client, selector)).id : undefined
    const result = await callBots<{ sessionId: string | null }>(client, 'bots.chat.reset', {
      ...callerChat(),
      ...(botId ? { botId } : {})
    })
    printResult(result, json, () => 'Started a new Home Chat. The old one stays in history.')
  },
  'bot memory forget': async ({ flags, client, json }) => {
    const fact = getOptionalStringFlag(flags, 'fact')
    if (!fact) {
      throw new RuntimeClientError('invalid_argument', 'Missing --fact')
    }
    const selector = getOptionalStringFlag(flags, 'bot')
    const botId = selector ? (await findBot(client, selector)).id : undefined
    const result = await callBots<{ forgot: boolean }>(client, 'bots.memory.forget', {
      ...callerChat(),
      ...(botId ? { botId } : {}),
      fact
    })
    if (!result.result.forgot) {
      throw new RuntimeClientError(
        'invalid_argument',
        'No line in MEMORY.md states that fact. Pass its words as the line has them.'
      )
    }
    printResult(result, json, () => 'Forgot it.')
  },
  'bot chats': async ({ flags, client, json }) => {
    const selector = getOptionalStringFlag(flags, 'bot')
    const botId = selector ? (await findBot(client, selector)).id : undefined
    const result = await callBots<BotChatsResult>(client, 'bots.chats', {
      ...callerChat(),
      ...(botId ? { botId } : {}),
      ...(flags.has('all') ? { all: true } : {})
    })
    printResult(result, json, (value) => formatBotChats(value))
  },
  'bot list': async ({ client, json }) => {
    const result = await client.call<{
      bots: BotRosterEntry[]
      unreachable?: { name: string }[]
      clients?: BotRosterClient[]
    }>('bots.roster', { ...callerChat(), allComputers: true })
    printResult(result, json, (value) => {
      const unreachable = (value.unreachable ?? []).map((server) =>
        formatUnreachableBotServer(server.name)
      )
      // Computers paired to this Orca: a server's agents reach their bots with --on-client.
      const clients = (value.clients ?? []).map(formatPairedClient)
      return value.bots.length === 0
        ? [
            clients.length > 0 ? 'No bots on this computer.' : 'No bots.',
            ...unreachable,
            ...clients
          ].join('\n\n')
        : [
            ...value.bots.map(formatBotRosterEntry),
            ...unreachable,
            ...clients,
            '',
            BOT_ROSTER_COMMANDS
          ].join('\n\n')
    })
  }
}
