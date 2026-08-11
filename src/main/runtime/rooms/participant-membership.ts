import type { RoomEvent, RoomHarnessAgent, RoomParticipant } from '../../../shared/rooms'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter, RoomHarnessBinding } from './harness-adapter'
import {
  hideRoomParticipantRendererStatus,
  roomParticipantHarnessBinding
} from './participant-harness-binding'
import type { RoomTranscriptBridge } from './transcript-bridge'

export type RoomParticipantConnection =
  | { kind: 'launch'; worktreeId: string }
  | {
      kind: 'attach'
      worktreeId: string
      terminalHandle: string
      paneKey: string
    }
  | { kind: 'resume'; worktreeId: string; historyId: string }

export class RoomParticipantMembership {
  constructor(
    private readonly db: RoomDatabase,
    private readonly adapters: Record<RoomHarnessAgent, RoomHarnessAdapter>,
    private readonly transcriptBridge: RoomTranscriptBridge,
    private readonly emit: (roomId: string, event: RoomEvent) => void,
    private readonly hideRendererStatus: ((paneKey: string) => void) | undefined,
    private readonly waitUntilReady: (
      participant: RoomParticipant,
      requireInputReady?: boolean
    ) => Promise<RoomParticipant>
  ) {}

  async add(input: {
    roomId: string
    identity: string
    displayName: string
    agent: RoomHarnessAgent
    roleId?: string | null
    connection: RoomParticipantConnection
  }): Promise<RoomParticipant> {
    const room = this.db.core.get(input.roomId)
    if (room.archivedAt) {
      throw new Error('room_archived')
    }
    if (room.worktreeId && room.worktreeId !== input.connection.worktreeId) {
      throw new Error('room_worktree_mismatch')
    }
    if (getRepoIdFromWorktreeId(input.connection.worktreeId) !== room.projectId) {
      throw new Error('room_worktree_project_mismatch')
    }
    const adapter = this.adapters[input.agent]
    const binding = await this.connect(adapter, input.connection)
    try {
      let participant = this.db.participants.add({
        roomId: input.roomId,
        identity: input.identity,
        displayName: input.displayName,
        agent: input.agent,
        roleId: input.roleId,
        worktreeId: binding.worktreeId,
        paneKey: binding.paneKey,
        terminalHandle: binding.terminalHandle,
        providerSession: binding.providerSession,
        processIncarnation: adapter.incarnation(binding),
        terminalSurfaceVisible: input.connection.kind === 'attach'
      })
      hideRoomParticipantRendererStatus(participant, this.hideRendererStatus)
      participant = this.db.participants.update(participant.id, { state: 'starting' })
      this.emit(input.roomId, { type: 'participant.updated', participant })
      await this.transcriptBridge.ensure(participant)
      return await this.waitUntilReady(participant, binding.disposition === 'created')
    } catch (error) {
      if (binding.disposition === 'created') {
        await adapter.stop(binding).catch(() => {})
      }
      throw error
    }
  }

  async remove(id: string): Promise<void> {
    const participant = this.db.participants.get(id)
    if (this.db.core.get(participant.roomId).archivedAt) {
      throw new Error('room_archived')
    }
    const binding = roomParticipantHarnessBinding(participant)
    if (participant.agent && binding) {
      await this.adapters[participant.agent].stop(binding)
    }
    this.transcriptBridge.disposeParticipant(id)
    this.db.participants.remove(id)
    this.emit(participant.roomId, { type: 'participant.removed', participantId: id })
  }

  private async connect(
    adapter: RoomHarnessAdapter,
    connection: RoomParticipantConnection
  ): Promise<RoomHarnessBinding> {
    if (connection.kind === 'launch') {
      return adapter.launch(connection.worktreeId)
    }
    if (connection.kind === 'resume') {
      return adapter.resume(connection.worktreeId, connection.historyId)
    }
    return adapter.attach({ ...connection, providerSession: null })
  }
}
