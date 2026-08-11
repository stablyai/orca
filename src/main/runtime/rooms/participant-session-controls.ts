import { isAgentSessionControlCommand } from '../../../shared/agent-session-control-command'
import type { AgentLaunchPreferences } from '../../../shared/agent-session-host-authority'
import type { RoomEvent, RoomHarnessAgent, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter, RoomHarnessBinding } from './harness-adapter'
import {
  hideRoomParticipantRendererStatus,
  roomParticipantHarnessBinding
} from './participant-harness-binding'
import type { RoomTranscriptBridge } from './transcript-bridge'

const CONTROL_CONFIRMATION_TIMEOUT_MS = 10_000
const CONTROL_CONFIRMATION_POLL_MS = 100

export class RoomParticipantSessionControls {
  constructor(
    private readonly db: RoomDatabase,
    private readonly adapters: Record<RoomHarnessAgent, RoomHarnessAdapter>,
    private readonly transcriptBridge: RoomTranscriptBridge,
    private readonly emit: (roomId: string, event: RoomEvent) => void,
    private readonly hideRendererStatus: ((paneKey: string) => void) | undefined,
    private readonly ensureReady: (id: string) => Promise<RoomParticipant>,
    private readonly waitUntilReady: (
      participant: RoomParticipant,
      requireInputReady?: boolean
    ) => Promise<RoomParticipant>
  ) {}

  async compact(id: string): Promise<RoomParticipant> {
    let participant = this.db.participants.get(id)
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = roomParticipantHarnessBinding(participant)
    if (!adapter || !binding) {
      throw new Error('room_agent_not_attached')
    }
    participant = this.setCompaction(participant, 'requested')
    try {
      const result = await adapter.compact(binding)
      if (!result.accepted) {
        throw new Error(result.refusedReason ?? 'room_compaction_refused')
      }
      const current = this.db.participants.get(id)
      return current.context.compaction === 'completed'
        ? current
        : this.setCompaction(current, 'running')
    } catch (error) {
      this.setCompaction(
        participant,
        'failed',
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
  }

  async control(id: string, command: string): Promise<RoomParticipant> {
    let participant = this.db.participants.get(id)
    if (!participant.agent || !isAgentSessionControlCommand(participant.agent, command)) {
      throw new Error('room_agent_control_unsupported')
    }
    if (participant.state === 'busy') {
      throw new Error('room_agent_busy')
    }
    participant = await this.ensureReady(id)
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = roomParticipantHarnessBinding(participant)
    if (!adapter || !binding) {
      throw new Error('room_agent_not_attached')
    }
    this.transcriptBridge.suppressSessionControl(id)
    try {
      await adapter.prepareControl?.(binding, command)
      const sentAt = Date.now()
      const result = await adapter.send(binding, command)
      if (!result.accepted) {
        throw new Error(result.refusedReason ?? 'room_agent_control_refused')
      }
      const expectedFastMode = claudeFastModeTarget(participant, command)
      return expectedFastMode === null
        ? participant
        : await this.waitForFastModeConfirmation(
            participant,
            adapter,
            binding,
            expectedFastMode,
            sentAt
          )
    } catch (error) {
      this.transcriptBridge.clearSessionControlSuppression(id)
      throw error
    }
  }

  async reconfigure(id: string, preferences: AgentLaunchPreferences): Promise<RoomParticipant> {
    let participant = this.db.participants.get(id)
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = roomParticipantHarnessBinding(participant)
    if (!adapter || !binding || participant.state === 'busy') {
      throw new Error(participant.state === 'busy' ? 'room_agent_busy' : 'room_agent_not_attached')
    }
    participant = this.db.participants.update(id, { state: 'starting' })
    this.emit(participant.roomId, { type: 'participant.updated', participant })
    this.transcriptBridge.disposeParticipant(id)
    try {
      const configured = await adapter.reconfigure(binding, preferences)
      participant = this.db.participants.update(id, {
        worktreeId: configured.worktreeId,
        paneKey: configured.paneKey,
        terminalHandle: configured.terminalHandle,
        providerSession: configured.providerSession,
        processIncarnation: adapter.incarnation(configured),
        context: {
          ...participant.context,
          model: preferences.model ?? participant.context.model,
          effort: preferences.effort ?? participant.context.effort,
          ...(preferences.mode === 'fast'
            ? { fastMode: true }
            : preferences.mode === 'standard'
              ? { fastMode: false }
              : {}),
          observedAt: Date.now()
        }
      })
      hideRoomParticipantRendererStatus(participant, this.hideRendererStatus)
      this.emit(participant.roomId, { type: 'participant.updated', participant })
      await this.transcriptBridge.ensure(participant)
      return await this.waitUntilReady(participant, true)
    } catch (error) {
      participant = this.db.participants.update(id, { state: 'error' })
      this.emit(participant.roomId, { type: 'participant.updated', participant })
      throw error
    }
  }

  private async waitForFastModeConfirmation(
    participant: RoomParticipant,
    adapter: RoomHarnessAdapter,
    binding: RoomHarnessBinding,
    expected: boolean,
    sentAt: number
  ): Promise<RoomParticipant> {
    const baseline = { ...participant.context, fastMode: !expected, observedAt: sentAt }
    const deadline = sentAt + CONTROL_CONFIRMATION_TIMEOUT_MS
    while (Date.now() < deadline) {
      const context = await adapter.context(binding, baseline)
      if (context.fastMode === expected) {
        const updated = this.db.participants.update(participant.id, { context })
        this.emit(updated.roomId, { type: 'participant.updated', participant: updated })
        return updated
      }
      await new Promise((resolve) => setTimeout(resolve, CONTROL_CONFIRMATION_POLL_MS))
    }
    throw new Error('room_agent_control_unconfirmed')
  }

  private setCompaction(
    participant: RoomParticipant,
    compaction: RoomParticipant['context']['compaction'],
    error?: string
  ): RoomParticipant {
    const updated = this.db.participants.update(participant.id, {
      context: { ...participant.context, compaction, compactionUpdatedAt: Date.now(), error }
    })
    this.emit(updated.roomId, { type: 'participant.updated', participant: updated })
    return updated
  }
}

function claudeFastModeTarget(participant: RoomParticipant, command: string): boolean | null {
  if (participant.agent !== 'claude' && participant.agent !== 'openclaude') {
    return null
  }
  const match = /^\/fast (on|off)$/.exec(command.trim())
  return match ? match[1] === 'on' : null
}
