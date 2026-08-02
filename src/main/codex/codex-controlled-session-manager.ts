import type { spawn } from 'node:child_process'
import type {
  ConversationWakeProvider,
  ConversationWakeProviderState,
  ConversationWakeTarget,
  ConversationWakeTurnRequest
} from '../runtime/orchestration/conversation-wake-provider'
import { CodexControlledSessionRegistry } from './codex-controlled-session-registry'
import type { ControlledCodexSession } from './codex-controlled-session-registry'
import { CodexControlledTurnFinalizer } from './codex-controlled-turn-finalizer'
import {
  getControlledSocketRoot,
  resolveControlledCodexCommand,
  type ControlledCodexCommand,
  type CodexControlledSessionLaunch
} from './codex-controlled-session-launch'

export type { CodexControlledSessionLaunch } from './codex-controlled-session-launch'

export type CodexControlledSessionIdentity = {
  conversationId: string
  threadId: string
  terminalHandle: string
  terminalPtyId: string | null
  terminalTabId: string
  terminalPaneKey: string
  worktreeId: string
}

export type CodexControlledSessionLaunchResult = {
  identity: CodexControlledSessionIdentity
  disposition: 'created' | 'reused'
  surface: 'visible'
}

export type CodexControlledNewSessionLaunch = Omit<CodexControlledSessionLaunch, 'threadId'> & {
  operationId: string
  prompt?: string
}

export type PreparedCodexControlledNewSessionLaunch = {
  input: CodexControlledNewSessionLaunch
  command: ControlledCodexCommand
}

type ControlledTerminalLaunch = {
  worktreeSelector: string
  command: string
  cwd: string
  env: Record<string, string>
  conversationId: string
  threadId: string
  presentation: 'focused'
}

export type CodexControlledSessionManagerOptions = {
  stateRoot: string
  createVisibleTerminal: (launch: ControlledTerminalLaunch) => Promise<{
    handle: string
    ptyId?: string | null
    tabId?: string
    paneKey?: string | null
    worktreeId?: string
    surface?: 'background' | 'visible'
  }>
  waitForVisibleTerminal: (
    terminal: CodexControlledSessionIdentity
  ) => Promise<CodexControlledSessionIdentity>
  closeVisibleTerminal: (terminal: CodexControlledSessionIdentity) => Promise<void>
  resolveCurrentAccountId: () => string | null
  isControlledLaunchEnabled?: () => boolean
  isProviderEnabled?: () => boolean
  isWakeEnabled?: () => boolean
  isKillSwitchOpen?: () => boolean
  socketRoot?: string
  spawnProcess?: typeof spawn
}

type ThreadShape = {
  status?: { type?: unknown }
  canAcceptDirectInput?: unknown
}

const CODEX_THREAD_NOT_FOUND_RPC_CODE = -32600

export class CodexControlledSessionManager implements ConversationWakeProvider {
  readonly id = 'codex-controlled'
  private readonly terminalListeners = new Set<(conversationId: string) => void>()
  private readonly registry: CodexControlledSessionRegistry

  constructor(private readonly options: CodexControlledSessionManagerOptions) {
    this.registry = new CodexControlledSessionRegistry(
      options,
      () => getControlledSocketRoot(options.socketRoot),
      (session, method, params) => this.observeNotification(session, method, params),
      (conversationId) => this.emitTerminal(conversationId),
      (session) => {
        if (!this.isProviderAvailable()) {
          throw new Error('controlled Codex wake is disabled')
        }
        this.assertAccountCurrent(session)
      },
      (input) => this.assertLaunchAllowed(input)
    )
  }

  async launch(input: CodexControlledSessionLaunch): Promise<CodexControlledSessionLaunchResult> {
    this.assertLaunchAllowed(input)
    return this.registry.launch(input)
  }

  async launchNew(
    input: CodexControlledNewSessionLaunch
  ): Promise<CodexControlledSessionLaunchResult> {
    return this.launchPreparedNew(this.prepareNewLaunch(input))
  }

  prepareNewLaunch(
    input: CodexControlledNewSessionLaunch,
    command: ControlledCodexCommand = resolveControlledCodexCommand(input.command)
  ): PreparedCodexControlledNewSessionLaunch {
    this.assertLaunchAllowed({ ...input, threadId: 'pending' })
    return { input, command }
  }

  launchPreparedNew(
    prepared: PreparedCodexControlledNewSessionLaunch
  ): Promise<CodexControlledSessionLaunchResult> {
    return this.registry.launchNew(prepared.input, prepared.command)
  }

  async getState(target: ConversationWakeTarget): Promise<ConversationWakeProviderState> {
    if (!this.isProviderAvailable()) {
      return 'unknown'
    }
    const session = this.registry.get(target.conversationId)
    if (!session || session.missing) {
      return 'missing'
    }
    if (!this.isAccountCurrent(session)) {
      return 'unknown'
    }
    try {
      session.terminal = await this.registry.refresh(session)
      const thread = await this.readThread(session, false)
      if (thread.status?.type === 'active') {
        return 'active'
      }
      return thread.status?.type === 'idle' && thread.canAcceptDirectInput === true
        ? 'idle'
        : 'unsupported'
    } catch (error) {
      return isMissingThreadError(error) ? 'missing' : 'unknown'
    }
  }

  async prepareAndFinalizeTurn(
    request: ConversationWakeTurnRequest
  ): ReturnType<CodexControlledTurnFinalizer['prepareAndFinalize']> {
    if (!this.isProviderAvailable()) {
      throw new Error('controlled Codex wake is disabled')
    }
    const session = this.registry.get(request.conversationId)
    if (!session || session.missing) {
      throw new Error('controlled Codex conversation is missing')
    }
    this.assertAccountCurrent(session)
    return new CodexControlledTurnFinalizer(
      { threadId: session.launch.threadId, client: session.client, state: session.state },
      () =>
        this.isProviderAvailable() &&
        this.options.resolveCurrentAccountId() === session.launch.accountId
    ).prepareAndFinalize(request)
  }

  onTurnTerminal(listener: (conversationId: string) => void): () => void {
    this.terminalListeners.add(listener)
    return () => this.terminalListeners.delete(listener)
  }

  async reconcile(): Promise<void> {
    if (!this.isProviderAvailable()) {
      return
    }
    await Promise.allSettled(
      [...this.registry.values()]
        .filter((session) => !session.missing && this.isAccountCurrent(session))
        .map(async (session) => {
          try {
            session.terminal = await this.registry.refresh(session)
            await this.readThread(session, false)
          } catch (error) {
            if (isMissingThreadError(error)) {
              session.missing = true
            }
          }
        })
    )
  }

  disposeConversation(conversationId: string): Promise<void> {
    return this.registry.disposeConversation(conversationId)
  }

  async dispose(): Promise<void> {
    await this.registry.dispose()
    this.terminalListeners.clear()
  }

  getConversationForPane(paneKey: string): string | null {
    return this.registry.getConversationForPane(paneKey)
  }

  private async readThread(
    session: ControlledCodexSession,
    includeTurns: boolean
  ): Promise<ThreadShape> {
    const response = await session.client.request('thread/read', {
      threadId: session.launch.threadId,
      includeTurns
    })
    if (!isRecord(response) || !isRecord(response.thread)) {
      throw new Error('controlled Codex thread/read returned an invalid response')
    }
    return response.thread as ThreadShape
  }

  private observeNotification(
    session: ControlledCodexSession,
    method: string,
    params: Record<string, unknown>
  ): void {
    if (
      (method === 'turn/completed' || method === 'thread/status/changed') &&
      params.threadId === session.launch.threadId
    ) {
      this.emitTerminal(session.launch.conversationId)
    }
  }

  private emitTerminal(conversationId: string): void {
    for (const listener of this.terminalListeners) {
      try {
        listener(conversationId)
      } catch {
        // One observer must not prevent delivery to the remaining observers.
      }
    }
  }

  private assertLaunchAllowed(input: CodexControlledSessionLaunch): void {
    if (!this.isProviderAvailable() || !this.options.isControlledLaunchEnabled?.()) {
      throw new Error('controlled Codex launch is disabled')
    }
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error('controlled Codex launch is unsupported on this platform')
    }
    if (input.hostKind !== 'local' || input.workspaceKind !== 'worktree') {
      throw new Error('controlled Codex launch requires a local worktree host')
    }
    if (this.options.resolveCurrentAccountId() !== input.accountId) {
      throw new Error('controlled Codex launch account changed')
    }
  }

  private assertAccountCurrent(session: ControlledCodexSession): void {
    if (!this.isAccountCurrent(session)) {
      throw new Error('controlled Codex account changed')
    }
  }

  private isAccountCurrent(session: ControlledCodexSession): boolean {
    return this.options.resolveCurrentAccountId() === session.launch.accountId
  }

  private isProviderAvailable(): boolean {
    return (
      (this.options.isProviderEnabled?.() ?? false) &&
      (this.options.isWakeEnabled?.() ?? false) &&
      (this.options.isKillSwitchOpen?.() ?? true)
    )
  }
}

function isMissingThreadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as Error & { rpcCode?: unknown }).rpcCode === CODEX_THREAD_NOT_FOUND_RPC_CODE ||
      /thread.*(?:not found|missing)|rollout.*not found/i.test(error.message))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
