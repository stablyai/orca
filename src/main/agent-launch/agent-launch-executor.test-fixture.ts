import { EVERY_AGENT_CHAT } from '../../shared/native-chat/every-agent-chat.test-fixture'
import { vi } from 'vitest'
import { executeAgentLaunch, type AgentLaunchExecution } from './agent-launch-executor'
import type { AgentLaunchSurfaceFactory } from './agent-launch-surface-factories'
import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'

export const STRUCTURED_PREFERENCE = {
  nativeChatProviders: EVERY_AGENT_CHAT
}

/** A stub host for the executor, recording each runtime and factory call it receives. */
export function harness(options: {
  settings?: Record<string, unknown> | null
  createSupport?: { supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }
  createSupportThrows?: boolean
  structuredCreateError?: Error
  terminalCreateError?: Error
  deliveredMessageId?: string | null
  terminalPromptDelivered?: boolean
  repos?: { id: string; agentAccounts?: unknown }[]
  lineCarriesPrompt?: boolean
  worktreeCreateError?: Error
  onStructuredCreate?: () => void
  onSurfacePublished?: AgentLaunchExecution['onSurfacePublished']
  worktreeOnlyFactory?: boolean
}) {
  const calls: string[] = []
  const carried = (startupPrompt: string | undefined) =>
    startupPrompt && (options.lineCarriesPrompt ?? true) ? { promptRodeLaunchCommand: true } : {}
  const createWorktree = vi.fn(
    async (args: {
      create: Record<string, unknown>
      startupAgent: string | undefined
      promisedAgentChat?: boolean
      startupPrompt?: string
      onWorkspaceCreated?: (worktreeId: string) => void
    }) => {
      calls.push(`createWorktree(startupAgent=${String(args.startupAgent)})`)
      args.onWorkspaceCreated?.('wt-new')
      if (options.worktreeCreateError) {
        throw options.worktreeCreateError
      }
      return {
        worktreeId: 'wt-new',
        workspacePath: '/repo/task',
        connectionId: null,
        startupTerminalHandle: args.startupAgent ? 'term_agent_first' : undefined,
        ...carried(args.startupPrompt)
      }
    }
  )
  const createFolderWorkspace = vi.fn(async (_args: { create: Record<string, unknown> }) => {
    calls.push('createFolderWorkspace')
    return { worktreeId: 'folder:fw-new', workspacePath: '/repo/task', connectionId: null }
  })
  const createRecoveryShell = vi.fn(async (_worktreeId: string) => {
    calls.push('createRecoveryShell')
  })
  const getStructuredAgentSessionCreateSupport = vi.fn(async () => {
    calls.push('createSupport')
    if (options.createSupportThrows) {
      throw new Error('host unreachable')
    }
    return options.createSupport ?? { supported: true }
  })
  const createStructuredSession = vi.fn(
    async (args: Parameters<AgentLaunchSurfaceFactory['createStructuredSession']>[0]) => {
      calls.push('createStructuredSession')
      options.onStructuredCreate?.()
      if (options.structuredCreateError) {
        throw options.structuredCreateError
      }
      return {
        sessionId: 'sess-1',
        handle: 'handle_structured',
        fence: 4,
        ...(args.firstMessage && options.deliveredMessageId !== null
          ? { firstMessage: { clientMessageId: 'msg-1' } }
          : {})
      }
    }
  )
  const createTerminalAgent = vi.fn(async (args: { startupPrompt?: string }) => {
    calls.push('createTerminalAgent')
    if (options.terminalCreateError) {
      throw options.terminalCreateError
    }
    return { handle: 'term_1', ...carried(args.startupPrompt) }
  })
  const deliverTerminalPrompt = vi.fn(async () => {
    calls.push('deliverTerminalPrompt')
    return options.terminalPromptDelivered ?? true
  })
  const runtime = {
    requireStore: () => ({
      getSettings: () => (options.settings === undefined ? STRUCTURED_PREFERENCE : options.settings)
    }),
    getStructuredAgentSessionCreateSupport,
    listRepos: () => options.repos ?? []
  }
  return {
    calls,
    runtime,
    createWorktree,
    createFolderWorkspace,
    createRecoveryShell,
    createStructuredSession,
    createTerminalAgent,
    deliverTerminalPrompt,
    run: (intent: AgentLaunchIntent) =>
      executeAgentLaunch({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements only the runtime methods the executor reaches, and each test asserts the calls made, so an omitted method throws rather than reading a wrong value.
        runtime: runtime as unknown as AgentLaunchExecution['runtime'],
        intent,
        surfaces: {
          createStructuredSession,
          createTerminalAgent,
          deliverTerminalPrompt
        },
        workspaces: options.worktreeOnlyFactory
          ? { createWorktree, createRecoveryShell }
          : { createWorktree, createFolderWorkspace, createRecoveryShell },
        ...(options.onSurfacePublished ? { onSurfacePublished: options.onSurfacePublished } : {})
      })
  }
}
