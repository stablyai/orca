// What New bot asks the chosen computer: its agent choices, and its Orca account.
import * as z from 'zod'
import { BOT_AGENTS, type BotAgent } from '../../../src/shared/bot-types'
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
      z
        .looseObject({ agents: z.array(z.string()), defaultAgent: z.unknown().optional() })
        .transform(({ agents, defaultAgent }) => {
          // A newer host's agent this build can't name or draw is left out.
          const known = BOT_AGENTS.filter((agent) => agents.includes(agent))
          return { agents: known, defaultAgent: known.find((agent) => agent === defaultAgent) }
        })
    )
  })
)

export type NewBotAgentChoices = {
  agents: BotAgent[]
  /** The agent the host's own New bot picks first; absent from an older host. */
  defaultAgent?: BotAgent
}

/** The agents the host's own New bot offers there. A host that can't say (an older build, a failed
 *  read) keeps every agent, as the desktop keeps a failed check choosable. */
export async function readNewBotAgentChoices(client: RpcClient): Promise<NewBotAgentChoices> {
  try {
    return botAgentChoicesRead.interpret(await botAgentChoicesRead.request(client))
  } catch {
    return { agents: [...BOT_AGENTS] }
  }
}

export async function readBotAgentChoices(client: RpcClient): Promise<BotAgent[]> {
  return (await readNewBotAgentChoices(client)).agents
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

/** The host's Orca sign-in, as its status says it; null when it can't say (an older host, a failed read). */
export async function readOrcaAccount(
  client: RpcClient
): Promise<{ state: string; email?: string } | null> {
  try {
    return orcaAccountStatusRead.interpret(await orcaAccountStatusRead.request(client))
  } catch {
    return null
  }
}

/** The account a host is signed in to, or null when it isn't (or can't say). */
export async function readSignedInEmail(client: RpcClient): Promise<string | null> {
  const account = await readOrcaAccount(client)
  return account?.state === 'signed-in' && account.email ? account.email : null
}
