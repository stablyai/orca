import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener'
import type { ClaudeStatusLineRateLimits } from '../../../shared/claude-statusline-rate-limits'
import type { RoomEvent, RoomHarnessAgent, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter } from './harness-adapter'
import type { RoomTranscriptBridge } from './transcript-bridge'
import type { AgentLaunchPreferences } from '../../../shared/agent-session-host-authority'
import {
  hibernateIdleRoomParticipants,
  markRoomParticipantSleeping
} from './participant-hibernation'
import {
  hideRoomParticipantRendererStatus,
  roomParticipantHarnessBinding
} from './participant-harness-binding'
import { roomParticipantRestartPreferences } from './participant-restart-preferences'
import { waitForRoomParticipantReady } from './participant-readiness'
import { RoomParticipantSessionControls } from './participant-session-controls'
import { RoomParticipantMembership } from './participant-membership'
import {
  ingestRoomParticipantClaudeStatusLine,
  ingestRoomParticipantStatus,
  updateRoomParticipantStatus
} from './participant-status'

/** An idle harness process costs hundreds of MB; a sleeping participant is a DB row.
 *  Provider thread, preferences and worktree persist until the next delivery. */
export { ROOM_AGENT_IDLE_SLEEP_MS } from './participant-hibernation'

const HIBERNATION_SWEEP_MS = 5 * 60 * 1000

export type { RoomParticipantConnection } from './participant-membership'

export class RoomParticipantController {
  private readonly restoring = new Map<string, Promise<RoomParticipant>>()
  private readonly membership: RoomParticipantMembership
  private readonly sessionControls: RoomParticipantSessionControls
  private hibernationTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly db: RoomDatabase,
    private readonly adapters: Record<RoomHarnessAgent, RoomHarnessAdapter>,
    private readonly transcriptBridge: RoomTranscriptBridge,
    private readonly emit: (roomId: string, event: RoomEvent) => void,
    private readonly hideRendererStatus?: (paneKey: string) => void
  ) {
    this.membership = new RoomParticipantMembership(
      db,
      adapters,
      transcriptBridge,
      emit,
      hideRendererStatus,
      (participant, requireInputReady) => this.waitUntilReady(participant, requireInputReady)
    )
    this.sessionControls = new RoomParticipantSessionControls(
      db,
      adapters,
      transcriptBridge,
      emit,
      hideRendererStatus,
      (id) => this.ensureReady(id),
      (participant, requireInputReady) => this.waitUntilReady(participant, requireInputReady)
    )
  }

  startHibernationSweep(): void {
    this.hibernationTimer = setInterval(() => {
      void this.hibernateIdle().catch(() => {})
    }, HIBERNATION_SWEEP_MS)
    this.hibernationTimer.unref?.()
  }

  dispose(): void {
    if (this.hibernationTimer) {
      clearInterval(this.hibernationTimer)
      this.hibernationTimer = null
    }
  }

  async add(input: Parameters<RoomParticipantMembership['add']>[0]): Promise<RoomParticipant> {
    return this.membership.add(input)
  }

  async remove(id: string): Promise<void> {
    return this.membership.remove(id)
  }

  async restore(participant: RoomParticipant, requireReady = false): Promise<RoomParticipant> {
    const active = this.restoring.get(participant.id)
    if (active) {
      const restored = await active
      return requireReady ? this.waitUntilReady(restored) : restored
    }
    const restore = this.restoreParticipant(participant, requireReady).finally(() => {
      this.restoring.delete(participant.id)
    })
    this.restoring.set(participant.id, restore)
    return restore
  }

  async ensureReady(id: string): Promise<RoomParticipant> {
    let participant = this.db.participants.get(id)
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = roomParticipantHarnessBinding(participant)
    if (!adapter || !binding) {
      throw new Error('room_agent_not_attached')
    }
    let status: Awaited<ReturnType<RoomHarnessAdapter['status']>>
    try {
      status = await adapter.status(binding)
    } catch {
      // A persisted handle can be stale after Orca restarts; the provider session is durable.
      return this.restore(participant, true)
    }
    if (status.isRunningAgent) {
      if (status.status === 'permission') {
        throw new Error('room_agent_permission')
      }
      participant = updateRoomParticipantStatus(
        this.db,
        this.adapters,
        this.emit,
        participant,
        true,
        status.status
      )
      return status.status === 'idle' ? participant : this.waitUntilReady(participant)
    }
    return this.restore(participant, true)
  }

  /** Room activation observes existing processes; only delivery/reveal may wake one. */
  async reconcile(participant: RoomParticipant): Promise<RoomParticipant> {
    if (participant.state === 'sleeping') {
      // Opening a room must not boot processes; the next delivery wakes.
      return participant
    }
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = roomParticipantHarnessBinding(participant)
    if (!adapter || !binding) {
      return markRoomParticipantSleeping(this.db, this.emit, participant)
    }
    try {
      const status = await adapter.status(binding)
      if (status.isRunningAgent) {
        return updateRoomParticipantStatus(
          this.db,
          this.adapters,
          this.emit,
          participant,
          true,
          status.status
        )
      }
    } catch {
      const located = await adapter.locate(binding)
      if (located) {
        participant = this.db.participants.update(participant.id, {
          terminalHandle: located.terminalHandle,
          paneKey: located.paneKey,
          ...(located.providerSession ? { providerSession: located.providerSession } : {})
        })
        hideRoomParticipantRendererStatus(participant, this.hideRendererStatus)
        const status = await adapter.status(located).catch(() => null)
        if (!status) {
          return updateRoomParticipantStatus(
            this.db,
            this.adapters,
            this.emit,
            participant,
            true,
            null
          )
        }
        if (status.isRunningAgent) {
          return updateRoomParticipantStatus(
            this.db,
            this.adapters,
            this.emit,
            participant,
            true,
            status.status
          )
        }
      }
    }
    return markRoomParticipantSleeping(this.db, this.emit, participant)
  }

  /** Stops harness processes of provably idle participants; only a live agent
   *  reporting 'idle' is stopped, a dead pane is just recorded as sleeping. */
  async hibernateIdle(now = Date.now()): Promise<void> {
    await hibernateIdleRoomParticipants({
      db: this.db,
      adapters: this.adapters,
      restoring: this.restoring,
      emit: this.emit,
      hideRendererStatus: this.hideRendererStatus,
      now
    })
  }

  private async restoreParticipant(
    participant: RoomParticipant,
    requireReady: boolean
  ): Promise<RoomParticipant> {
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = roomParticipantHarnessBinding(participant)
    if (!adapter || !binding) {
      throw new Error('room_agent_not_attached')
    }
    let current = this.db.participants.update(participant.id, { state: 'starting' })
    this.emit(current.roomId, { type: 'participant.updated', participant: current })
    try {
      const canResume =
        !binding.providerSession ||
        this.db.providerMessages.hasObservedSession(participant.id, binding.providerSession.id)
      const restored = await adapter.restore(
        canResume ? binding : { ...binding, providerSession: null },
        roomParticipantRestartPreferences(participant)
      )
      const incarnation = adapter.incarnation(restored)
      // Only a proven restart must re-prove readiness: a fresh launch, or both
      // incarnations known and different. Provider-session state survives it.
      const restarted =
        restored.disposition === 'created' ||
        (participant.processIncarnation !== null &&
          incarnation !== null &&
          incarnation !== participant.processIncarnation)
      current = this.db.participants.update(participant.id, {
        worktreeId: restored.worktreeId,
        paneKey: restored.paneKey,
        terminalHandle: restored.terminalHandle,
        providerSession: restored.providerSession,
        // Never erase a known incarnation with a transient null.
        ...(incarnation !== null ? { processIncarnation: incarnation } : {})
      })
      hideRoomParticipantRendererStatus(current, this.hideRendererStatus)
      this.emit(current.roomId, { type: 'participant.updated', participant: current })
      await this.transcriptBridge.ensure(current)
      if (!restarted) {
        return requireReady
          ? this.waitUntilReady(current)
          : updateRoomParticipantStatus(this.db, this.adapters, this.emit, current, true, 'idle')
      }
      try {
        return await this.waitUntilReady(current, true)
      } catch (readinessError) {
        const permission =
          readinessError instanceof Error && readinessError.message === 'room_agent_permission'
        if (requireReady || restored.disposition === 'created' || permission) {
          throw readinessError
        }
        // Adopted long-lived silent PTYs never emit an idle transition; after
        // the bounded wait expires, trust the adoption as before.
        return updateRoomParticipantStatus(this.db, this.adapters, this.emit, current, true, 'idle')
      }
    } catch (error) {
      current = this.db.participants.update(participant.id, { state: 'error' })
      this.emit(current.roomId, { type: 'participant.updated', participant: current })
      throw error
    }
  }

  async compact(id: string): Promise<RoomParticipant> {
    return this.sessionControls.compact(id)
  }

  async control(id: string, command: string): Promise<RoomParticipant> {
    return this.sessionControls.control(id, command)
  }

  async reconfigure(id: string, preferences: AgentLaunchPreferences): Promise<RoomParticipant> {
    return this.sessionControls.reconfigure(id, preferences)
  }

  ingestStatus(event: AgentHookEventPayload & { receivedAt: number }): void {
    ingestRoomParticipantStatus(this.db, this.adapters, this.transcriptBridge, this.emit, event)
  }

  ingestClaudeStatusLine(event: ClaudeStatusLineRateLimits): void {
    ingestRoomParticipantClaudeStatusLine(this.db, this.emit, event)
  }

  private async waitUntilReady(
    participant: RoomParticipant,
    requireInputReady = false
  ): Promise<RoomParticipant> {
    return waitForRoomParticipantReady(
      this.db,
      this.adapters,
      this.emit,
      participant,
      requireInputReady
    )
  }
}
