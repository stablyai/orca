// What New bot asks the chosen computer: its agent choices, and its Orca account.
import * as z from 'zod'
import { BOT_AGENTS } from '../../../src/shared/bot-types'
import type { BotNewChatAgent } from '../../../src/shared/bots/bot-agent-choices'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

const botAgentChoicesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.agent-choices',
    method: 'bots.agentChoices',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bot-agent-choices',
      z.looseObject({ agents: z.array(z.string()) }).transform(({ agents }) =>
        // A newer host's agent this build can't name or draw is left out.
        BOT_AGENTS.filter((agent) => agents.includes(agent))
      )
    )
  })
)

/** The agents the host's own New bot offers there. A host that can't say lists every agent as a
 *  failed check, as the desktop's menu does, and offers none. */
export async function readBotAgentChoices(client: RpcClient): Promise<BotNewChatAgent[]> {
  try {
    const agents = botAgentChoicesRead.interpret(await botAgentChoicesRead.request(client))
    return agents.map((agent) => ({ agent }))
  } catch {
    return BOT_AGENTS.map((agent) => ({ agent, unavailable: 'check-failed' }))
  }
}

const orcaAccountStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'orca-account.status',
    method: 'orcaAccount.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'orca-account-status',
      z.looseObject({ state: z.string(), email: z.string().optional() })
    )
  })
)

/** The account a host is signed in to, or null when it isn't (or can't say). */
export async function readSignedInEmail(client: RpcClient): Promise<string | null> {
  try {
    const status = orcaAccountStatusRead.interpret(await orcaAccountStatusRead.request(client))
    return status.state === 'signed-in' && status.email ? status.email : null
  } catch {
    return null
  }
}
