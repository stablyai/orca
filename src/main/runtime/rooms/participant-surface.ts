import type { RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessRuntime } from './harness-adapter'
import type { RoomParticipantController } from './participant-controller'

export class RoomParticipantSurface {
  constructor(
    private readonly db: RoomDatabase,
    private readonly participants: RoomParticipantController,
    private readonly focusTerminal: RoomHarnessRuntime['focusTerminal'],
    private readonly hideRendererStatus: RoomHarnessRuntime['hideRoomAgentStatusFromRenderer'],
    private readonly publishAgentSession: RoomHarnessRuntime['publishRoomAgentProviderSession'],
    private readonly publishStructuredSession: RoomHarnessRuntime['publishStructuredAgentSessionTab']
  ) {}

  async reveal(id: string, viewMode: 'terminal' | 'chat'): Promise<void> {
    const participant = await this.participants.ensureReady(id)
    if (
      participant.providerSession?.transport === 'machine' &&
      participant.agent &&
      participant.worktreeId &&
      viewMode === 'chat'
    ) {
      if (!this.publishStructuredSession) {
        throw new Error('room_participant_not_ready')
      }
      await this.publishStructuredSession({
        workspaceId: participant.worktreeId,
        sessionId: participant.providerSession.id,
        agent: participant.agent,
        activate: true
      })
      return
    }
    if (!this.focusTerminal) {
      throw new Error('room_participant_not_ready')
    }
    if (!participant.terminalHandle) {
      throw new Error('room_participant_not_ready')
    }
    await this.focusTerminal(participant.terminalHandle, { viewMode })
    const revealed = this.db.participants.update(participant.id, {
      terminalHandle: participant.terminalHandle,
      paneKey: participant.paneKey,
      providerSession: participant.providerSession,
      terminalSurfaceVisible: true
    })
    this.publish(revealed, true)
  }

  hide(handle: string): void {
    const participant = this.db.participants.findByTerminalHandle(handle)
    if (!participant?.terminalSurfaceVisible) {
      return
    }
    const hidden = this.db.participants.update(participant.id, { terminalSurfaceVisible: false })
    if (hidden.paneKey) {
      this.hideRendererStatus?.(hidden.paneKey)
    }
  }

  publish({ terminalHandle, agent, providerSession }: RoomParticipant, force = false): void {
    if (terminalHandle && agent && providerSession) {
      this.publishAgentSession?.(terminalHandle, agent, providerSession, force)
    }
  }
}
