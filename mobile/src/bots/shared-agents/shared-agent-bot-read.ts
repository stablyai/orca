// A shared agent's row as its host lists it to this account (name, avatar, last activity), read over
// whichever client reaches that host: a page's, which its shell routes to the phone's own link, or the
// phone's own route to it.
import { toRuntimeExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import type { SharedBotHostView } from '../../../../src/shared/bots/shared-bot-hosts'
import { hostBotsKey, readHostBots } from '../host-bots-read'
import type { PhoneBot } from '../host-bots-operations'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { scopeRpcClientToExecutionHost } from '../../worktree/execution-hosts/execution-host-scoped-rpc-client'

/** The client that reaches the agent's host, from a client that reaches its computer. */
export function sharedAgentClient(client: RpcClient, environmentId: string): RpcClient {
  return scopeRpcClientToExecutionHost(client, toRuntimeExecutionHostId(environmentId))
}

export async function readSharedAgentBot(
  client: RpcClient,
  pairedHostId: string,
  view: Pick<SharedBotHostView, 'environmentId' | 'botId'>
): Promise<PhoneBot | undefined> {
  const read = await readHostBots(
    sharedAgentClient(client, view.environmentId),
    hostBotsKey(pairedHostId, toRuntimeExecutionHostId(view.environmentId))
  )
  return read.kind === 'bots' ? read.bots.find((bot) => bot.id === view.botId) : undefined
}
