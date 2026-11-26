import type { MobileQuickCommandLaunch } from '../../quick-commands/quick-commands'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { MobileNewTabAgentOption } from '../../../session/agent-launch/mobile-new-tab-agent-options'
import { sessionTabCreateTerminal } from '../../../session/tabs/mobile-session-tab-write-operations'

export type MobileSessionTerminalCreateOptions = MobileQuickCommandLaunch['options'] & {
  /** Resolve a startup command after claiming the terminal creation slot. */
  prepareStartupCommand?: (client: RpcClient) => Promise<string>
  onPromptSent?: () => void
  errorToast?: string
  sourceChatFork?: { sessionId: string; agent: string }
  /** Show the tab as a terminal even when the agent it runs would open as a chat. */
  terminalView?: boolean
  /** One of desktop's Windows shell entries; only sent to hosts that take a shell pick. */
  shell?: string
}

export async function requestMobileSessionTerminalCreate(args: {
  client: RpcClient
  worktreeId: string
  afterTabId?: string
  clientMutationId: string
  agent?: MobileNewTabAgentOption['agent']
  options?: MobileSessionTerminalCreateOptions
  isCurrent: () => boolean
  shell?: string
  sourceChatFork?: { sessionId: string }
  viewMode?: 'chat'
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
    viewMode
  } = args
  const prepare = options?.prepareStartupCommand
  const command = prepare ? await prepare(client) : options?.startupCommand
  if (prepare && !args.isCurrent()) {
    return null
  }
  const params = {
    worktree: `id:${worktreeId}`,
    afterTabId,
    clientMutationId,
    ...(command ? { command } : {}),
    ...(options?.startupCommandDelivery
      ? { startupCommandDelivery: options.startupCommandDelivery }
      : {}),
    ...(options?.agentPrompt ? { agentPrompt: options.agentPrompt } : {}),
    ...(agent ? { agent } : {}),
    ...(shell ? { shell } : {}),
    ...(sourceChatFork ? { sourceChatFork } : {}),
    ...(viewMode ? { viewMode } : {}),
    activate: false,
    select: true,
    navigation: 'caller' as const
  }
  return sourceChatFork
    ? sessionTabCreateTerminal.request(client, params, { timeoutMs: 120_000 })
    : sessionTabCreateTerminal.request(client, params)
}
