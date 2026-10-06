/**
 * The runtime surface `agent.launch` reaches, and nothing else.
 *
 * Shared by the RPC-boundary tests and the replay-safety tests so both drive the same host: a stub
 * that diverges between them would let one file prove something the other's launch never does.
 */

import { vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { AgentLaunchPaneAlreadyLiveError } from '../../../../shared/agent-launch-pane-already-live'
import type { RpcContext } from '../core'
import { resolveRpcCallerIdentity } from '../rpc-caller-identity'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'

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
  /** The pane `createTerminal` minted. Off by default so the existing outcome assertions keep
   *  modelling a runtime that reports none — the arm `RuntimeTerminalCreate.paneKey?` allows. */
  terminalPaneKey?: string
  /** The pane minted with an agent-first worktree's startup terminal. */
  startupTerminalPaneKey?: string
  /** The reserved pane is already live, so a create that requires a fresh pane is refused. */
  terminalPaneAlreadyLive?: boolean
  /** What the runtime reports about an offered prompt's typed line; unset reports nothing. */
  lineCarriesPrompt?: boolean
  /** Panes this runtime found already running, by the handle it issued them: a restarted host
   *  that could not re-adopt a surviving PTY's handle issues a new one for the same pane. */
  adoptedPanes?: Record<string, string>
}

function reportPromptCarry(
  options: AgentLaunchRuntimeStubOptions,
  report: unknown,
  offered: unknown
): void {
  if (typeof report === 'function' && offered && options.lineCarriesPrompt !== undefined) {
    report(options.lineCarriesPrompt)
  }
}

let launchRecordStore: AgentSessionRecordStore | null = null

/** The ledger every stub's `openAgentSessionRecordStore` opens, as a process opens its one store. */
export function setAgentLaunchRecordStore(store: AgentSessionRecordStore | null): void {
  launchRecordStore = store
}

export function runtimeStub(options: AgentLaunchRuntimeStubOptions = {}) {
  const worktreeCreateResults = new Map<string, Promise<unknown>>()
  // Only the panes this runtime created or adopted, under the handle it issued them.
  const handlesByPaneKey = new Map(Object.entries(options.adoptedPanes ?? {}))
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
    createManagedWorktree: vi.fn(async (args: Record<string, unknown>) => {
      reportPromptCarry(options, args.onStartupPromptCarry, args.startupPrompt)
      if (args.startupAgent && options.startupTerminalPaneKey) {
        handlesByPaneKey.set(options.startupTerminalPaneKey, 'term_agent_first')
      }
      return {
        worktree: { id: 'wt-new' },
        startupTerminal: args.startupAgent
          ? {
              handle: 'term_agent_first',
              ...(options.startupTerminalPaneKey ? { paneKey: options.startupTerminalPaneKey } : {})
            }
          : undefined,
        ...(options.setupReceipt ? { setupReceipt: options.setupReceipt } : {}),
        ...(options.createWarning ? { warning: options.createWarning } : {})
      }
    }),
    // Args are declared so a test can assert what the launch asked for, not merely that it asked.
    createTerminal: vi.fn(async (_selector: string, createOptions?: Record<string, unknown>) => {
      if (options.terminalPaneAlreadyLive && createOptions?.requireFreshPane === true) {
        throw new AgentLaunchPaneAlreadyLiveError()
      }
      reportPromptCarry(options, createOptions?.onStartupPromptCarry, createOptions?.startupPrompt)
      if (options.terminalPaneKey) {
        handlesByPaneKey.set(options.terminalPaneKey, 'term_1')
      }
      return {
        handle: 'term_1',
        ...(options.terminalPaneKey ? { paneKey: options.terminalPaneKey } : {}),
        ...(options.terminalWarning ? { warning: options.terminalWarning } : {})
      }
    }),
    showTerminal: vi.fn(async (handle: string) => ({ handle, worktreeId: 'wt-7' })),
    getTerminalHandleForPaneKey: vi.fn((paneKey: string) => handlesByPaneKey.get(paneKey) ?? null),
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
    openAgentSessionRecordStore: vi.fn(async (): Promise<AgentSessionRecordStore> => {
      if (!launchRecordStore) {
        throw new Error('agent_session_record_store_unavailable')
      }
      return launchRecordStore
    }),
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
// The caller is stamped the way the dispatcher stamps it from the same transport fields.
export function rpcContext(
  runtime: AgentLaunchRuntimeStub,
  context: Partial<RpcContext>
): RpcContext {
  const caller = context.caller ?? resolveRpcCallerIdentity(context)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements only the runtime surface these methods reach, so a method it omits throws on call rather than reading a wrong value.
  return { runtime, ...context, ...(caller ? { caller } : {}) } as unknown as RpcContext
}

export const CAPABLE_CLIENT: Partial<RpcContext> = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}
