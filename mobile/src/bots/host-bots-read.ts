import * as z from 'zod'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host/execution-host'
import type { ConnectorCloudStatus } from '../../../src/shared/bots/connector-cloud-status'
import {
  BOTS_CREATE_RUNTIME_CAPABILITY,
  BOTS_MOBILE_RUNTIME_CAPABILITY,
  BOTS_SESSION_LINKS_RUNTIME_CAPABILITY,
  BOTS_TEMPLATES_RUNTIME_CAPABILITY
} from '../../../src/shared/bot-runtime-capabilities'
import { folderWorkspaceKey } from '../../../src/shared/workspace/identity/workspace-scope'
import { readProbedHostCapabilities } from '../transport/connection/host-status-probe-operations'
import { readHostStatusReply } from '../query/host-status-query'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import type { SendRequestOptions } from '../transport/rpc/unvalidated-rpc-request-port'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import { noteListedBots } from './bot-avatar-uploads'
import { publishHostBots } from './host-bot-store'
import { botsListRead, type PhoneBot } from './host-bots-operations'
import { mobileBotRefusalText } from './mobile-bot-refusal-text'
import { readAgentSessionErrorRefusal } from '../../../src/shared/agent-session/failures/agent-session-write-failure'
import type { BotSidebarView } from '../../../src/shared/bots/bot-sidebar-view'
import type { BotListWaits } from '../../../src/shared/bots/bot-list-waits'

/** What a link or count needs of a bot; every reader gets the full `PhoneBot`. */
export type HostBot = Pick<PhoneBot, 'id' | 'name' | 'folderWorkspaceId'>

/** What one paired host said about its bots; `no-capability` is a host too old to list them for phones. */
export type HostBotsAnswer =
  | { kind: 'bots'; bots: HostBot[]; sessionItemLinks?: true }
  | { kind: 'no-capability' }
  | { kind: 'unreadable' }

export type HostBotsRead =
  | {
      kind: 'bots'
      bots: PhoneBot[]
      hideBotCreated: boolean
      view: BotSidebarView
      /** The host's Bots switch: off, it lists none and takes no new bot. */
      enabled: boolean
      /** The host is new enough to take bots.create from a phone. */
      takesCreate: boolean
      sessionItemLinks?: true
      /** The host makes bots from template packages; older ones take only the five seed-only templates. */
      takesTemplates: boolean
      /** Each bot's waits still waiting, by bot id; empty from an older host. */
      waits: BotListWaits
      /** Each bot's Needs you items that aren't stale, by bot id; empty from an older host. */
      needsYou: Readonly<Record<string, number>>
      /** When those counts next change, as one goes stale or a snoozed one comes back. */
      needsYouChangeInMs?: number
      /** The host's Orca Cloud link; absent from an older host, which keeps today's card line. */
      connectorStatus?: ConnectorCloudStatus
      /** Its Orca Cloud answers an event in that event's thread, for an automation's results. */
      threadReplies?: boolean
    }
  | { kind: 'no-capability' }
  | { kind: 'unreadable' }

/** Names one execution host as the phone reaches it: the paired host, or a server it relays. */
export function hostBotsKey(
  pairedHostId: string,
  executionHostId: string = LOCAL_EXECUTION_HOST_ID
): string {
  return `${pairedHostId}\n${executionHostId}`
}

// Readers that ask while a list is out join it instead of sending their own.
const botListFlights = new WeakMap<RpcClient, Map<string, Promise<RpcResponse>>>()

function joinBotsList(client: RpcClient, key: string): Promise<RpcResponse> {
  const flights = botListFlights.get(client) ?? new Map<string, Promise<RpcResponse>>()
  botListFlights.set(client, flights)
  const out = flights.get(key)
  if (out) {
    return out
  }
  const flight = botsListRead.request(client).finally(() => flights.delete(key))
  flights.set(key, flight)
  return flight
}

/** The phone's one read of a host's bots, behind the connection's capability check; every reader
 *  shares its flights and its last answer. Never rejects: one host cannot stall the others. */
export async function readHostBots(
  client: RpcClient,
  key: string,
  options?: SendRequestOptions
): Promise<HostBotsRead> {
  try {
    const capabilities = readProbedHostCapabilities(await readHostStatusReply(client, options))
    if (options?.signal?.aborted) {
      return { kind: 'unreadable' }
    }
    options?.beforeSend?.()
    if (capabilities === null) {
      return { kind: 'unreadable' }
    }
    if (!capabilities.includes(BOTS_MOBILE_RUNTIME_CAPABILITY)) {
      return { kind: 'no-capability' }
    }
    const reply = botsListRead.interpret(
      await (options ? botsListRead.request(client, undefined, options) : joinBotsList(client, key))
    )
    if (!reply.accepted) {
      return { kind: 'unreadable' }
    }
    const read: HostBotsRead = {
      kind: 'bots',
      ...reply.value,
      ...(capabilities.includes(BOTS_SESSION_LINKS_RUNTIME_CAPABILITY)
        ? { sessionItemLinks: true as const }
        : {}),
      takesCreate: capabilities.includes(BOTS_CREATE_RUNTIME_CAPABILITY),
      takesTemplates: capabilities.includes(BOTS_TEMPLATES_RUNTIME_CAPABILITY)
    }
    if (options?.signal?.aborted) {
      return { kind: 'unreadable' }
    }
    options?.beforeSend?.()
    publishHostBots(key, read)
    noteListedBots(client, read.bots)
    return read
  } catch {
    return { kind: 'unreadable' }
  }
}

const botHomeChatOpen = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.chat.open',
    method: 'bots.chat.open',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-home-chat', z.unknown())
  })
)

// The desktop's open: a bot that never ran has no Home Chat until the host starts one. Bots switched off refuse; the workspace still opens.
/** Resolves with why the host refused to start the Home Chat, null when it opened or failed otherwise. */
export async function ensureBotHomeChat(
  client: RpcClient,
  botId: string,
  options?: SendRequestOptions
): Promise<string | null> {
  try {
    botHomeChatOpen.interpret(await botHomeChatOpen.request(client, { botId }, options))
    return null
  } catch (error) {
    // Opening the workspace without the chat beats not opening it.
    const refusal = readAgentSessionErrorRefusal(error)
    return refusal ? mobileBotRefusalText(refusal) : null
  }
}

/** The worktree id a bot's home folder workspace carries in `worktree.ps`. */
export function botHomeWorktreeId(bot: Pick<HostBot, 'folderWorkspaceId'>): string {
  return folderWorkspaceKey(bot.folderWorkspaceId)
}
