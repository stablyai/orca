import type { MobileQuickCommandLaunch } from '../../quick-commands/quick-commands'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { MobileNewTabAgentOption } from '../../../session/agent-launch/mobile-new-tab-agent-options'
import { sessionTabCreateTerminal } from '../../../session/tabs/mobile-session-tab-write-operations'

export type MobileSessionTerminalCreateOptions = MobileQuickCommandLaunch['options'] & {
  onPromptSent?: () => void
  errorToast?: string
  /** With throughEntryId, a terminal Claude chat's fork cut at that transcript entry. */
  sourceChatFork?: { sessionId: string; agent: string; throughEntryId?: string }
  /** Show the tab as a terminal even when the agent it runs would open as a chat. */
  terminalView?: boolean
}

/** The fork source the host reads: the session, and the transcript cut only when one was picked. */
export function chatForkRequestSource(fork: { sessionId: string; throughEntryId?: string }): {
  sessionId: string
  throughEntryId?: string
} {
  return {
    sessionId: fork.sessionId,
    ...(fork.throughEntryId ? { throughEntryId: fork.throughEntryId } : {})
  }
}

export function requestMobileSessionTerminalCreate(args: {
  client: RpcClient
  worktreeId: string
  afterTabId?: string
  clientMutationId: string
  agent?: MobileNewTabAgentOption['agent']
  options?: MobileQuickCommandLaunch['options']
  sourceChatFork?: { sessionId: string; throughEntryId?: string }
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
