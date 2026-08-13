import { randomBytes } from 'node:crypto'
import type { RoomAttachment, RoomContextSnapshot, RoomHarnessAgent } from '../../../shared/rooms'
import type { AgentLaunchPreferences } from '../../../shared/agent-session-host-authority'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalClose,
  RuntimeTerminalSend,
  RuntimeTerminalWait
} from '../../../shared/runtime-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener'
import {
  readNativeChatTranscriptTail,
  type NativeChatTranscriptSubscription
} from '../../native-chat/transcript-watch'
import { readRoomContext, readRoomTranscriptMtime } from './context-reader'
import { roomHarnessStatusEvent, type RoomHarnessLifecycleEvent } from './harness-lifecycle'
import type {
  RoomHarnessAdapter,
  RoomHarnessBinding,
  RoomHarnessReadResult,
  RoomHarnessRuntime,
  RoomHarnessSubscriptionCallbacks
} from './harness-adapter-types'
import { subscribeRoomHarnessTranscript } from './harness-transcript-subscription'
import { resolveRoomTerminalRestorationSurface } from './room-terminal-restoration-surface'
import { interruptRoomHarness } from './room-harness-interrupt'
import { roomHarnessBindingFromTerminal } from './participant-harness-binding'
import { ensureLiveRoomHarnessSession, ROOM_AGENT_EXTRA_ARGS } from './room-harness-session-launch'

export { transcriptLifecycleEvent } from './harness-lifecycle'
export type { RoomHarnessActivityKind, RoomHarnessLifecycleEvent } from './harness-lifecycle'
export type {
  RoomHarnessAdapter,
  RoomHarnessBinding,
  RoomHarnessReadResult,
  RoomHarnessRuntime
} from './harness-adapter-types'

export class PtyRoomHarnessAdapter implements RoomHarnessAdapter {
  constructor(
    readonly agent: RoomHarnessAgent,
    private readonly runtime: RoomHarnessRuntime
  ) {}

  async launch(
    worktreeId: string,
    preferences?: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding> {
    return this.launchAt(worktreeId, preferences)
  }

  private async launchAt(
    worktreeId: string,
    preferences?: AgentLaunchPreferences,
    paneKey = ''
  ): Promise<RoomHarnessBinding> {
    const surface = resolveRoomTerminalRestorationSurface(this.runtime, worktreeId, paneKey)
    const result = await this.runtime.createAgentSession({
      clientOperationId: `${Date.now()}-${randomBytes(16).toString('hex')}`,
      worktree: `id:${worktreeId}`,
      agent: this.agent,
      extraAgentArgs: ROOM_AGENT_EXTRA_ARGS[this.agent],
      launchPreferences: preferences,
      presentation: 'background',
      viewMode: 'chat',
      ...(surface.placement ? { placement: surface.placement } : {}),
      surfaceOwner: false,
      persistHostSessionBinding: surface.persisted
    })
    return roomHarnessBindingFromTerminal(worktreeId, result.terminal, null, 'created')
  }

  async connectExisting(input: {
    worktreeId: string
    terminalHandle?: string
    paneKey?: string
    historyId?: string
  }): Promise<RoomHarnessBinding> {
    if (input.terminalHandle && input.paneKey) {
      const match = (await this.runtime.listRoomRunningAgents(input.worktreeId)).find(
        (candidate) =>
          candidate.agent === this.agent &&
          candidate.worktreeId === input.worktreeId &&
          candidate.terminalHandle === input.terminalHandle &&
          candidate.paneKey === input.paneKey
      )
      if (match) {
        return {
          worktreeId: match.worktreeId,
          terminalHandle: match.terminalHandle,
          paneKey: match.paneKey,
          providerSession: match.providerSession,
          disposition: 'adopted',
          terminalSurfaceVisible: true
        }
      }
    }
    if (!input.historyId) {
      throw new Error('room_agent_not_running')
    }
    const providerSession = await this.runtime.resolveRoomHistoricalSession(
      input.worktreeId,
      this.agent,
      input.historyId
    )
    return this.restore({
      worktreeId: input.worktreeId,
      terminalHandle: '',
      paneKey: '',
      providerSession
    })
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
    options?: {
      beforeWrite?: (ptyId: string) => void | Promise<void>
      clearInput?: boolean
      imagePaths?: readonly string[]
    }
  ): Promise<RuntimeTerminalSend> {
    return options
      ? this.runtime.sendTerminalAgentPrompt(binding.terminalHandle, prompt, options)
      : this.runtime.sendTerminalAgentPrompt(binding.terminalHandle, prompt)
  }

  async interrupt(binding: RoomHarnessBinding): Promise<void> {
    await interruptRoomHarness(this.runtime, binding)
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
    return this.runtime.closeTerminal(binding.terminalHandle, {
      force: true,
      waitForExit: true
    })
  }

  /** Foreground-verified lookup of the live pane hosting this binding's agent.
   *  Provider session survives pane replacement; pane identity is the fallback
   *  before the provider has assigned one. */
  async locate(binding: RoomHarnessBinding): Promise<RoomHarnessBinding | null> {
    const current = (await this.runtime.listRoomRunningAgents(binding.worktreeId)).find(
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
      disposition: 'adopted',
      terminalSurfaceVisible:
        this.runtime.hasPersistedTerminalSurface?.(current.worktreeId, current.paneKey) === true
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
      return this.launchAt(binding.worktreeId, preferences, binding.paneKey)
    }
    return ensureLiveRoomHarnessSession({
      agent: this.agent,
      runtime: this.runtime,
      binding,
      preferences
    })
  }

  async reconfigure(
    binding: RoomHarnessBinding,
    preferences: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding> {
    const surface = resolveRoomTerminalRestorationSurface(
      this.runtime,
      binding.worktreeId,
      binding.paneKey
    )
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
        viewMode: 'chat',
        ...(surface.placement ? { placement: surface.placement } : {}),
        surfaceOwner: false,
        persistHostSessionBinding: surface.persisted
      })
      return roomHarnessBindingFromTerminal(binding.worktreeId, result.terminal, null, 'created')
    }
    const ensured = await ensureLiveRoomHarnessSession({
      agent: this.agent,
      runtime: this.runtime,
      binding,
      preferences,
      surface
    })
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
    return subscribeRoomHarnessTranscript(this.agent, binding, callbacks)
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
