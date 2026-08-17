import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener'
import type { AgentLaunchPreferences } from '../../../shared/agent-session-host-authority'
import { isStructuredMachineAgent } from '../../../shared/structured-agent-provider'
import type { RoomAttachment, RoomContextSnapshot, RoomHarnessAgent } from '../../../shared/rooms'
import { PtyRoomHarnessAdapter } from './harness-adapter'
import type {
  RoomHarnessAdapter,
  RoomHarnessBinding,
  RoomHarnessLaunchOptions,
  RoomHarnessRuntime,
  RoomHarnessSubscriptionCallbacks
} from './harness-adapter-types'
import { MachineRoomHarnessAdapter } from './machine-harness-adapter'
import { stopRoomParticipantProcess } from './participant-room-stop'

class RoutedRoomHarnessAdapter implements RoomHarnessAdapter {
  private readonly machine: MachineRoomHarnessAdapter | null

  constructor(
    readonly agent: RoomHarnessAgent,
    private readonly runtime: RoomHarnessRuntime,
    private readonly terminal = new PtyRoomHarnessAdapter(agent, runtime)
  ) {
    this.machine = isStructuredMachineAgent(agent)
      ? new MachineRoomHarnessAdapter(agent, runtime)
      : null
  }

  async launch(
    worktreeId: string,
    options?: RoomHarnessLaunchOptions
  ): Promise<RoomHarnessBinding> {
    if (this.shouldUseMachine(options)) {
      return this.machine!.launch(worktreeId, options)
    }
    return this.terminal.launch(worktreeId, options?.preferences)
  }

  async connectExisting(
    input: Parameters<RoomHarnessAdapter['connectExisting']>[0],
    options?: RoomHarnessLaunchOptions
  ): Promise<RoomHarnessBinding> {
    if (!this.shouldUseMachine(options)) {
      return this.terminal.connectExisting(input)
    }
    if (input.conversationId) {
      return this.machine!.connectExisting(input, options)
    }
    if (input.terminalHandle && input.paneKey) {
      const terminal = await this.terminal.connectExisting(input)
      const status = await this.terminal.status(terminal)
      if (!status.isRunningAgent || status.status !== 'idle' || !terminal.providerSession) {
        throw new Error('room_agent_not_ready')
      }
      await stopRoomParticipantProcess(this.terminal, terminal)
      try {
        const machine = await this.machine!.connectExisting(
          {
            worktreeId: input.worktreeId,
            providerSessionId:
              terminal.providerSession.sourceSessionId ?? terminal.providerSession.id
          },
          options
        )
        return { ...machine, handoffFrom: terminal }
      } catch (error) {
        try {
          await this.terminal.restore(terminal)
        } catch (restoreError) {
          throw new Error('room_agent_handoff_restore_failed', {
            cause: new AggregateError([error, restoreError], 'Machine handoff and rollback failed')
          })
        }
        throw error
      }
    }
    if (!input.historyId) {
      throw new Error('room_historical_session_not_found')
    }
    const session = await this.runtime.resolveRoomHistoricalSession(
      input.worktreeId,
      this.agent,
      input.historyId
    )
    return this.machine!.connectExisting(
      {
        worktreeId: input.worktreeId,
        providerSessionId: session.sourceSessionId ?? session.id
      },
      options
    )
  }

  locate(binding: RoomHarnessBinding) {
    return this.forBinding(binding).locate(binding)
  }

  read(binding: RoomHarnessBinding, limit?: number) {
    return this.forBinding(binding).read(binding, limit)
  }

  send(
    binding: RoomHarnessBinding,
    prompt: string,
    options?: Parameters<RoomHarnessAdapter['send']>[2]
  ) {
    return this.forBinding(binding).send(binding, prompt, options)
  }

  steer(
    binding: RoomHarnessBinding,
    prompt: string,
    options?: Parameters<NonNullable<RoomHarnessAdapter['steer']>>[2]
  ) {
    if (binding.transport !== 'machine') {
      throw new Error('conversation_steer_unsupported')
    }
    return this.machine!.steer(binding, prompt, options)
  }

  interrupt(binding: RoomHarnessBinding) {
    return this.forBinding(binding).interrupt(binding)
  }

  prepareControl(binding: RoomHarnessBinding, command: string): Promise<void> {
    if (binding.transport === 'machine') {
      throw new Error('room_agent_control_unsupported')
    }
    return this.terminal.prepareControl(binding, command)
  }

  stop(binding: RoomHarnessBinding) {
    return this.forBinding(binding).stop(binding)
  }

  restore(binding: RoomHarnessBinding, preferences?: AgentLaunchPreferences) {
    return binding.transport === 'machine'
      ? this.machine!.restore(binding, preferences)
      : this.terminal.restore(binding, preferences)
  }

  reconfigure(binding: RoomHarnessBinding, preferences: AgentLaunchPreferences) {
    return binding.transport === 'machine'
      ? this.machine!.reconfigure(binding, preferences)
      : this.terminal.reconfigure(binding, preferences)
  }

  status(binding: RoomHarnessBinding) {
    return this.forBinding(binding).status(binding)
  }

  incarnation(binding: RoomHarnessBinding): string | null {
    return binding.transport === 'machine' ? null : this.terminal.incarnation(binding)
  }

  awaitReady(binding: RoomHarnessBinding) {
    return this.forBinding(binding).awaitReady(binding)
  }

  awaitInputReady(binding: RoomHarnessBinding) {
    return this.forBinding(binding).awaitInputReady(binding)
  }

  context(binding: RoomHarnessBinding, current: RoomContextSnapshot) {
    return this.forBinding(binding).context(binding, current)
  }

  lastTranscriptActivityAt(binding: RoomHarnessBinding) {
    return this.forBinding(binding).lastTranscriptActivityAt(binding)
  }

  compact(binding: RoomHarnessBinding) {
    if (binding.transport === 'machine') {
      return this.machine!.compact(binding)
    }
    return this.terminal.compact(binding)
  }

  stageAttachment(
    binding: RoomHarnessBinding,
    attachment: Pick<RoomAttachment, 'id' | 'fileName' | 'localPath'>
  ) {
    return this.forBinding(binding).stageAttachment(binding, attachment)
  }

  statusEvent(event: AgentHookEventPayload & { receivedAt: number }) {
    return this.terminal.statusEvent(event)
  }

  subscribe(binding: RoomHarnessBinding, callbacks: RoomHarnessSubscriptionCallbacks) {
    return this.forBinding(binding).subscribe(binding, callbacks)
  }

  private forBinding(binding: RoomHarnessBinding): RoomHarnessAdapter {
    return (binding.transport === 'machine' ? this.machine : this.terminal) as RoomHarnessAdapter
  }

  private shouldUseMachine(options?: RoomHarnessLaunchOptions): boolean {
    return Boolean(
      options?.machineStreaming &&
      this.machine &&
      this.runtime.structuredAgentStreamingEnabled?.(this.agent) === true &&
      ((this.agent !== 'claude' && this.agent !== 'openclaude') || options.trusted === true)
    )
  }
}

export function createRoomHarnessAdapters(
  runtime: RoomHarnessRuntime
): Record<RoomHarnessAgent, RoomHarnessAdapter> {
  return {
    claude: new RoutedRoomHarnessAdapter('claude', runtime),
    openclaude: new RoutedRoomHarnessAdapter('openclaude', runtime),
    codex: new RoutedRoomHarnessAdapter('codex', runtime),
    grok: new RoutedRoomHarnessAdapter('grok', runtime),
    omp: new RoutedRoomHarnessAdapter('omp', runtime)
  }
}
