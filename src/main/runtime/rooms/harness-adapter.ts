/* eslint-disable max-lines -- Why: shared room harness lifecycle stays in one adapter. */
import { randomBytes } from 'node:crypto'
import type {
  RoomAttachment,
  RoomAttachableAgent,
  RoomContextSnapshot,
  RoomEvent,
  RoomHarnessAgent,
  RoomProviderSession
} from '../../../shared/rooms'
import type {
  AgentLaunchPreferences,
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../../shared/agent-session-host-authority'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalClose,
  RuntimeTerminalSend,
  RuntimeTerminalWait
} from '../../../shared/runtime-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import {
  readNativeChatTranscriptTail,
  subscribeNativeChatTranscript,
  type NativeChatTranscriptSubscription
} from '../../native-chat/transcript-watch'
import { readRoomContext, readRoomTranscriptMtime } from './context-reader'
import {
  currentTurnMessages,
  roomHarnessStatusEvent,
  transcriptLifecycleEvent,
  turnUserMessage,
  type RoomHarnessLifecycleEvent
} from './harness-lifecycle'

export { transcriptLifecycleEvent } from './harness-lifecycle'
export type { RoomHarnessActivityKind, RoomHarnessLifecycleEvent } from './harness-lifecycle'

export type RoomHarnessBinding = {
  worktreeId: string
  terminalHandle: string
  paneKey: string
  providerSession: RoomProviderSession | null
  disposition?: 'created' | 'adopted' | 'attached'
}

export type RoomHarnessRuntime = {
  createAgentSession(
    request: RuntimeCreateAgentSessionRequest
  ): Promise<RuntimeCreateAgentSessionResult>
  ensureAgentSession(
    request: RuntimeEnsureAgentSessionRequest
  ): Promise<RuntimeEnsureAgentSessionResult>
  sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options?: { clearInput?: boolean; imagePaths?: readonly string[] }
  ): Promise<RuntimeTerminalSend>
  sendTerminal?(
    handle: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean }
  ): Promise<RuntimeTerminalSend>
  waitForTerminalAgentInputReady(handle: string, agent: RoomHarnessAgent): Promise<boolean>
  compactTerminalAgentSession(handle: string): Promise<RuntimeTerminalSend>
  getTerminalAgentStatus(
    handle: string,
    options?: { confirmForeground?: boolean }
  ): Promise<RuntimeTerminalAgentStatus>
  /** Stable identity of the live process behind the handle; changes on every (re)start. */
  getTerminalProcessIncarnation(handle: string): string | null
  /** `force` bypasses the room-participant view-close guard: room-owned stops
   *  (remove, reconfigure) must actually kill the process. */
  closeTerminal(handle: string, options?: { force?: boolean }): Promise<RuntimeTerminalClose>
  waitForTerminal(
    handle: string,
    options?: { condition?: 'exit' | 'tui-idle'; timeoutMs?: number }
  ): Promise<RuntimeTerminalWait>
  focusTerminal?(
    handle: string,
    options?: { navigateHost?: boolean; viewMode?: 'terminal' | 'chat' }
  ): Promise<unknown>
  /** Push the participant's session identity into the shared agent-status stream
   *  so Chat UI/Terminal resolve the same providerSession/transcript the room owns. */
  publishRoomAgentProviderSession?(
    handle: string,
    agent: RoomHarnessAgent,
    providerSession: RoomProviderSession
  ): void
  emitRoomEvent?(roomId: string, event: RoomEvent): void
  listRoomAttachableAgents(worktreeId: string): Promise<RoomAttachableAgent[]>
  resolveRoomHistoricalSession(
    worktreeId: string,
    agent: RoomHarnessAgent,
    historyId: string
  ): Promise<RoomProviderSession>
  stageRoomAttachment(
    worktreeId: string,
    terminalHandle: string,
    attachment: Pick<RoomAttachment, 'id' | 'fileName' | 'localPath'>
  ): Promise<string>
}

export type RoomHarnessReadResult =
  | { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number }
  | { error: string; notFound?: true }

type RoomHarnessSubscriptionCallbacks = {
  onSnapshot: (messages: NativeChatMessage[]) => void
  onEvent: (event: RoomHarnessLifecycleEvent) => void
  onOpaqueAppend: () => void
}

export type RoomHarnessAdapter = {
  readonly agent: RoomHarnessAgent
  launch(worktreeId: string): Promise<RoomHarnessBinding>
  attach(binding: RoomHarnessBinding): Promise<RoomHarnessBinding>
  locate(binding: RoomHarnessBinding): Promise<RoomHarnessBinding | null>
  read(binding: RoomHarnessBinding, limit?: number): Promise<RoomHarnessReadResult>
  send(
    binding: RoomHarnessBinding,
    prompt: string,
    options?: { clearInput?: boolean; imagePaths?: readonly string[] }
  ): Promise<RuntimeTerminalSend>
  prepareControl?(binding: RoomHarnessBinding, command: string): Promise<void>
  stop(binding: RoomHarnessBinding): Promise<RuntimeTerminalClose>
  resume(worktreeId: string, historyId: string): Promise<RoomHarnessBinding>
  restore(
    binding: RoomHarnessBinding,
    preferences?: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding>
  reconfigure(
    binding: RoomHarnessBinding,
    preferences: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding>
  status(binding: RoomHarnessBinding): Promise<RuntimeTerminalAgentStatus>
  incarnation(binding: RoomHarnessBinding): string | null
  /** Resolves via the runtime's title-transition waiter once the TUI is idle. */
  awaitReady(binding: RoomHarnessBinding): Promise<RuntimeTerminalWait>
  /** Resolves only after the agent's composer is mounted and accepts input. */
  awaitInputReady(binding: RoomHarnessBinding): Promise<boolean>
  context(binding: RoomHarnessBinding, current: RoomContextSnapshot): Promise<RoomContextSnapshot>
  /** Conversation-source idle evidence: mtime of the provider transcript. */
  lastTranscriptActivityAt(binding: RoomHarnessBinding): Promise<number | null>
  compact(binding: RoomHarnessBinding): Promise<RuntimeTerminalSend>
  stageAttachment(
    binding: RoomHarnessBinding,
    attachment: Pick<RoomAttachment, 'id' | 'fileName' | 'localPath'>
  ): Promise<string>
  statusEvent(
    event: AgentHookEventPayload & { receivedAt: number }
  ): RoomHarnessLifecycleEvent | null
  subscribe(
    binding: RoomHarnessBinding,
    callbacks: RoomHarnessSubscriptionCallbacks
  ): Promise<NativeChatTranscriptSubscription>
}

/** Nobody watches a room pane, so any interactive CLI nudge deadlocks its
 *  deliveries (probe honestly reports 'permission'). Codex pops a mid-session
 *  rate-limit model-switch modal — where Enter silently switches the model —
 *  and a startup update prompt; both are suppressed by documented config keys
 *  (unknown keys are tolerated by older CLIs, verified against the binary). */
const ROOM_AGENT_EXTRA_ARGS: Partial<Record<RoomHarnessAgent, string>> = {
  codex: '-c notice.hide_rate_limit_model_nudge=true -c check_for_update_on_startup=false'
}

export class PtyRoomHarnessAdapter implements RoomHarnessAdapter {
  constructor(
    readonly agent: RoomHarnessAgent,
    private readonly runtime: RoomHarnessRuntime
  ) {}

  async launch(
    worktreeId: string,
    preferences?: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding> {
    const result = await this.runtime.createAgentSession({
      clientOperationId: `${Date.now()}-${randomBytes(16).toString('hex')}`,
      worktree: `id:${worktreeId}`,
      agent: this.agent,
      extraAgentArgs: ROOM_AGENT_EXTRA_ARGS[this.agent],
      launchPreferences: preferences,
      presentation: 'background',
      viewMode: 'chat'
    })
    return this.binding(worktreeId, result.terminal, null, 'created')
  }

  async attach(binding: RoomHarnessBinding): Promise<RoomHarnessBinding> {
    const match = (await this.runtime.listRoomAttachableAgents(binding.worktreeId)).find(
      (candidate) =>
        candidate.agent === this.agent &&
        candidate.worktreeId === binding.worktreeId &&
        candidate.terminalHandle === binding.terminalHandle &&
        candidate.paneKey === binding.paneKey
    )
    if (!match) {
      throw new Error('room_agent_not_running')
    }
    return {
      worktreeId: match.worktreeId,
      terminalHandle: match.terminalHandle,
      paneKey: match.paneKey,
      providerSession: match.providerSession,
      disposition: 'attached'
    }
  }

  read(binding: RoomHarnessBinding, limit = 200): Promise<RoomHarnessReadResult> {
    const session = binding.providerSession
    if (!session) {
      return Promise.resolve({ error: 'Transcript unavailable', notFound: true })
    }
    return readNativeChatTranscriptTail({
      agent: this.agent,
      sessionId: session.id,
      transcriptPath: session.transcriptPath,
      limit
    })
  }

  send(
    binding: RoomHarnessBinding,
    prompt: string,
    options?: { clearInput?: boolean }
  ): Promise<RuntimeTerminalSend> {
    return options
      ? this.runtime.sendTerminalAgentPrompt(binding.terminalHandle, prompt, options)
      : this.runtime.sendTerminalAgentPrompt(binding.terminalHandle, prompt)
  }

  async prepareControl(binding: RoomHarnessBinding, command: string): Promise<void> {
    if (this.agent !== 'claude' || !/^\/fast (?:on|off)$/.test(command.trim())) {
      return
    }
    if (!this.runtime.sendTerminal) {
      throw new Error('room_agent_control_unsupported')
    }
    await this.runtime.sendTerminal(binding.terminalHandle, { text: '\x1b' })
    if (!(await this.awaitInputReady(binding))) {
      throw new Error('room_agent_not_ready')
    }
  }

  stop(binding: RoomHarnessBinding): Promise<RuntimeTerminalClose> {
    return this.runtime.closeTerminal(binding.terminalHandle, { force: true })
  }

  async resume(worktreeId: string, historyId: string): Promise<RoomHarnessBinding> {
    const session = await this.runtime.resolveRoomHistoricalSession(
      worktreeId,
      this.agent,
      historyId
    )
    return this.restore({ worktreeId, terminalHandle: '', paneKey: '', providerSession: session })
  }

  /** Foreground-verified lookup of the live pane hosting this binding's agent.
   *  Provider session survives pane replacement; pane identity is the fallback
   *  before the provider has assigned one. */
  async locate(binding: RoomHarnessBinding): Promise<RoomHarnessBinding | null> {
    const current = (await this.runtime.listRoomAttachableAgents(binding.worktreeId)).find(
      (candidate) =>
        candidate.agent === this.agent &&
        candidate.worktreeId === binding.worktreeId &&
        (binding.providerSession
          ? candidate.providerSession?.key === binding.providerSession.key &&
            candidate.providerSession.id === binding.providerSession.id
          : Boolean(binding.paneKey && candidate.paneKey === binding.paneKey))
    )
    if (!current) {
      return null
    }
    return {
      worktreeId: current.worktreeId,
      terminalHandle: current.terminalHandle,
      paneKey: current.paneKey,
      providerSession: current.providerSession,
      disposition: 'attached'
    }
  }

  async restore(
    binding: RoomHarnessBinding,
    preferences?: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding> {
    const current = await this.locate(binding)
    if (current) {
      return current
    }
    if (!binding.providerSession) {
      return this.launch(binding.worktreeId, preferences)
    }
    return this.ensureLiveSession(binding.worktreeId, binding.providerSession, preferences)
  }

  /** Provider-session claims outlive their process: ensureAgentSession happily
   *  adopts a pane where the agent already died and only a shell remains. Any
   *  adoption must prove a live agent process; dead claim holders are killed
   *  and the session is re-ensured until it relaunches for real. */
  private async ensureLiveSession(
    worktreeId: string,
    providerSession: NonNullable<RoomHarnessBinding['providerSession']>,
    preferences?: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding> {
    // Bounded by the realistic number of stale claim holders per thread.
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await this.runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: `id:${worktreeId}`,
        agent: this.agent,
        providerSession,
        extraAgentArgs: ROOM_AGENT_EXTRA_ARGS[this.agent],
        launchPreferences: preferences,
        presentation: 'background'
      })
      if (result.disposition !== 'adopted') {
        return this.binding(worktreeId, result.terminal, providerSession, 'created')
      }
      const status = await this.runtime
        .getTerminalAgentStatus(result.terminal.handle, { confirmForeground: true })
        .catch(() => null)
      if (status?.isRunningAgent) {
        return this.binding(worktreeId, result.terminal, providerSession, 'adopted')
      }
      await this.runtime.closeTerminal(result.terminal.handle, { force: true }).catch(() => {})
    }
    throw new Error('room_agent_session_unrecoverable')
  }

  async reconfigure(
    binding: RoomHarnessBinding,
    preferences: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding> {
    // A stale handle (hibernated participant) means the process is already gone.
    await this.stop(binding).catch(() => {})
    if (!binding.providerSession) {
      const result = await this.runtime.createAgentSession({
        clientOperationId: `${Date.now()}-${randomBytes(16).toString('hex')}`,
        worktree: `id:${binding.worktreeId}`,
        agent: this.agent,
        extraAgentArgs: ROOM_AGENT_EXTRA_ARGS[this.agent],
        launchPreferences: preferences,
        presentation: 'background',
        viewMode: 'chat'
      })
      return this.binding(binding.worktreeId, result.terminal, null, 'created')
    }
    const ensured = await this.ensureLiveSession(
      binding.worktreeId,
      binding.providerSession,
      preferences
    )
    // Reconfiguration always requires readiness proof.
    return { ...ensured, disposition: 'created' }
  }

  status(binding: RoomHarnessBinding): Promise<RuntimeTerminalAgentStatus> {
    // Rooms paste prompts and block deliveries based on this status: title and
    // screen text survive an agent's death, so demand live-process evidence.
    return this.runtime.getTerminalAgentStatus(binding.terminalHandle, {
      confirmForeground: true
    })
  }

  incarnation(binding: RoomHarnessBinding): string | null {
    return this.runtime.getTerminalProcessIncarnation(binding.terminalHandle)
  }

  awaitReady(binding: RoomHarnessBinding): Promise<RuntimeTerminalWait> {
    return this.runtime.waitForTerminal(binding.terminalHandle, { condition: 'tui-idle' })
  }

  awaitInputReady(binding: RoomHarnessBinding): Promise<boolean> {
    return this.runtime.waitForTerminalAgentInputReady(binding.terminalHandle, this.agent)
  }

  context(binding: RoomHarnessBinding, current: RoomContextSnapshot): Promise<RoomContextSnapshot> {
    return binding.providerSession
      ? readRoomContext(this.agent, binding.providerSession, current)
      : Promise.resolve(current)
  }

  lastTranscriptActivityAt(binding: RoomHarnessBinding): Promise<number | null> {
    return binding.providerSession
      ? readRoomTranscriptMtime(this.agent, binding.providerSession)
      : Promise.resolve(null)
  }

  compact(binding: RoomHarnessBinding): Promise<RuntimeTerminalSend> {
    return this.runtime.compactTerminalAgentSession(binding.terminalHandle)
  }

  stageAttachment(
    binding: RoomHarnessBinding,
    attachment: Pick<RoomAttachment, 'id' | 'fileName' | 'localPath'>
  ): Promise<string> {
    return this.runtime.stageRoomAttachment(binding.worktreeId, binding.terminalHandle, attachment)
  }

  statusEvent(
    event: AgentHookEventPayload & { receivedAt: number }
  ): RoomHarnessLifecycleEvent | null {
    return roomHarnessStatusEvent(event)
  }

  subscribe(
    binding: RoomHarnessBinding,
    callbacks: RoomHarnessSubscriptionCallbacks
  ): Promise<NativeChatTranscriptSubscription> {
    const session = binding.providerSession
    if (!session) {
      return Promise.resolve({ watching: false, unsubscribe: () => {} })
    }
    return subscribeNativeChatTranscript({
      agent: this.agent,
      sessionId: session.id,
      transcriptPath: session.transcriptPath,
      initialLimit: 200,
      onInitialSnapshot: (messages, _hasMore, _beforeOffset, _error, lifecycle) => {
        callbacks.onSnapshot(messages)
        // The current-turn slice drops the user row, so re-derive it from the full tail.
        const event = transcriptLifecycleEvent(
          currentTurnMessages(messages),
          lifecycle,
          true,
          turnUserMessage(messages)
        )
        if (event) {
          callbacks.onEvent(event)
        }
      },
      onReplace: (messages, _hasMore, _beforeOffset, lifecycle) => {
        callbacks.onSnapshot(messages)
        const event = transcriptLifecycleEvent(
          currentTurnMessages(messages),
          lifecycle,
          true,
          turnUserMessage(messages)
        )
        if (event) {
          callbacks.onEvent(event)
        }
      },
      onAppend: (messages, lifecycle) => {
        const event = transcriptLifecycleEvent(messages, lifecycle)
        if (event) {
          callbacks.onEvent(event)
        }
      },
      onOpaqueAppend: callbacks.onOpaqueAppend
    })
  }

  private binding(
    worktreeId: string,
    terminal: RuntimeCreateAgentSessionResult['terminal'],
    providerSession: RoomProviderSession | null,
    disposition: RoomHarnessBinding['disposition']
  ): RoomHarnessBinding {
    if (!terminal.paneKey) {
      throw new Error('room_agent_pane_unavailable')
    }
    return {
      worktreeId,
      terminalHandle: terminal.handle,
      paneKey: terminal.paneKey,
      providerSession,
      disposition
    }
  }
}

export function createRoomHarnessAdapters(
  runtime: RoomHarnessRuntime
): Record<RoomHarnessAgent, RoomHarnessAdapter> {
  return {
    claude: new PtyRoomHarnessAdapter('claude', runtime),
    openclaude: new PtyRoomHarnessAdapter('openclaude', runtime),
    codex: new PtyRoomHarnessAdapter('codex', runtime),
    grok: new PtyRoomHarnessAdapter('grok', runtime)
  }
}
