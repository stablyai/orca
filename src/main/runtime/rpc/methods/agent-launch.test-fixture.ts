/**
 * The runtime surface `agent.launch` reaches, and nothing else.
 *
 * Shared by the RPC-boundary tests and the replay-safety tests so both drive the same host: a stub
 * that diverges between them would let one file prove something the other's launch never does.
 */

import { vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RpcContext } from '../core'

export const STRUCTURED_PREFERENCE = {
  experimentalNativeChat: true,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
}

export type AgentLaunchRuntimeStubOptions = {
  settings?: Record<string, unknown>
  createSupport?: { supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }
  setupReceipt?: {
    startupPolicy: 'start-immediately' | 'wait-for-setup'
    state: 'running' | 'skipped' | 'not_configured' | 'spawn_failed'
    terminalHandle?: string
  }
  /** What `createManagedWorktree` reports when the workspace exists but is incomplete. */
  createWarning?: string
  /** What `createTerminal` reports when the surface itself came up degraded. */
  terminalWarning?: string
}

export function runtimeStub(options: AgentLaunchRuntimeStubOptions = {}) {
  const worktreeCreateResults = new Map<string, Promise<unknown>>()
  const waitForSetupTerminalCompletion = vi.fn(
    async (_handle: string, _signal?: AbortSignal): Promise<{ exitCode: number | null }> => ({
      exitCode: 0
    })
  )
  return {
    getClientSettings: vi.fn(() => options.settings ?? STRUCTURED_PREFERENCE),
    getStructuredAgentSessionCreateSupport: vi.fn(
      async () => options.createSupport ?? { supported: true }
    ),
    dedupeWorktreeCreate: vi.fn(
      (repo: string, key: string | undefined, run: () => Promise<unknown>) => {
        if (!key) {
          return run()
        }
        const compositeKey = `${repo}\0${key}`
        const existing = worktreeCreateResults.get(compositeKey)
        if (existing) {
          return existing
        }
        const result = run()
        worktreeCreateResults.set(compositeKey, result)
        void result.catch(() => worktreeCreateResults.delete(compositeKey))
        return result
      }
    ),
    showRepo: vi.fn(async () => ({ id: 'repo-1' })),
    createManagedWorktree: vi.fn(async (args: Record<string, unknown>) => ({
      worktree: { id: 'wt-new' },
      startupTerminal: args.startupAgent ? { handle: 'term_agent_first' } : undefined,
      ...(options.setupReceipt ? { setupReceipt: options.setupReceipt } : {}),
      ...(options.createWarning ? { warning: options.createWarning } : {})
    })),
    // Args are declared so a test can assert what the launch asked for, not merely that it asked.
    createTerminal: vi.fn(async (_selector: string, _options?: Record<string, unknown>) => ({
      handle: 'term_1',
      ...(options.terminalWarning ? { warning: options.terminalWarning } : {})
    })),
    showTerminal: vi.fn(async (handle: string) => ({ handle, worktreeId: 'wt-7' })),
    isTerminalRunningAgent: vi.fn(async () => true),
    showManagedTerminalWorkspace: vi.fn(async (selector: string) => ({
      id: selector.replace(/^id:/, '')
    })),
    // The scope resolves for every workspace kind, so unlike the worktree record above it never
    // refuses the floating sentinel — which is the whole reason the launch asks for this one.
    showTerminalWorkspaceLaunchScope: vi.fn(async (selector: string) => ({
      id: selector.replace(/^id:/, ''),
      path: '/tmp/wt-7',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })),
    ensureStructuredAgentSessionHost: vi.fn(async () => {}),
    waitForSetupTerminalCompletion
  }
}

export type AgentLaunchRuntimeStub = ReturnType<typeof runtimeStub>

export function methodNamed<TMethod extends { name: string }, TName extends string>(
  methods: readonly TMethod[],
  name: TName
): Extract<TMethod, { name: TName }> {
  const found = methods.find(
    (entry): entry is Extract<TMethod, { name: TName }> => entry.name === name
  )
  if (!found) {
    throw new Error(`missing method ${name}`)
  }
  return found
}

// The one call the stub cannot satisfy structurally; every method it does implement is asserted.
export function rpcContext(
  runtime: AgentLaunchRuntimeStub,
  context: Partial<RpcContext>
): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements only the runtime surface these methods reach, so a method it omits throws on call rather than reading a wrong value.
  return { runtime, ...context } as unknown as RpcContext
}

export const CAPABLE_CLIENT: Partial<RpcContext> = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}
