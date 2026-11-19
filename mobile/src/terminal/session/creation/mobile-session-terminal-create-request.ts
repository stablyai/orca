import type { MobileQuickCommandLaunch } from '../../quick-commands/quick-commands'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { MobileNewTabAgentOption } from '../../../session/agent-launch/mobile-new-tab-agent-options'
import { sessionTabCreateTerminal } from '../../../session/tabs/mobile-session-tab-write-operations'

export type MobileSessionTerminalCreateOptions = MobileQuickCommandLaunch['options'] & {
  onPromptSent?: () => void
  errorToast?: string
  /** With throughEntryId, a terminal Claude chat's fork cut at that transcript entry. */
  sourceChatFork?: { sessionId: string; agent: string; throughEntryId?: string; name?: string }
  /** Show the tab as a terminal even when the agent it runs would open as a chat. */
  terminalView?: boolean
  /** One of desktop's Windows shell entries; only sent to hosts that take a shell pick. */
  shell?: string
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
  shell?: string
  sourceChatFork?: { sessionId: string; throughEntryId?: string }
  /** A fork's session name, for CLIs that take one. */
  forkName?: string
}) {
  const {
    client,
    worktreeId,
    afterTabId,
    clientMutationId,
    agent,
    options,
    shell,
    sourceChatFork,
    forkName
  } = args
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
    ...(shell ? { shell } : {}),
    ...(sourceChatFork ? { sourceChatFork } : {}),
    ...(sourceChatFork && forkName ? { forkName } : {}),
    activate: false,
    select: true,
    navigation: 'caller' as const
  }
  return sourceChatFork
    ? sessionTabCreateTerminal.request(client, params, { timeoutMs: 120_000 })
    : sessionTabCreateTerminal.request(client, params)
}
