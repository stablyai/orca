import type { MobileQuickCommandLaunch } from '../terminal/quick-commands'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'
import { sessionTabCreateTerminal } from './mobile-session-write-operations'

/** Keep the ordinary create payload while the chat fork adds only its source intent. */
export function requestMobileSessionTerminalCreate(args: {
  client: RpcClient
  worktreeId: string
  afterTabId?: string
  clientMutationId: string
  agent?: MobileNewTabAgentOption['agent']
  options?: MobileQuickCommandLaunch['options']
  sourceChatFork?: { sessionId: string }
}) {
  const { client, worktreeId, afterTabId, clientMutationId, agent, options, sourceChatFork } = args
  const params = {
    worktree: `id:${worktreeId}`,
    afterTabId,
    clientMutationId,
    ...(options?.startupCommand ? { command: options.startupCommand } : {}),
    ...(options?.startupCommandDelivery
      ? { startupCommandDelivery: options.startupCommandDelivery }
      : {}),
    ...(options?.agentPrompt ? { agentPrompt: options.agentPrompt } : {}),
    ...(agent ? { agent } : {}),
    ...(sourceChatFork ? { sourceChatFork } : {}),
    activate: false,
    select: true,
    navigation: 'caller' as const
  }
  return sourceChatFork
    ? sessionTabCreateTerminal.request(client, params, { timeoutMs: 120_000 })
    : sessionTabCreateTerminal.request(client, params)
}
