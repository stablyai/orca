import type { RoomEvent, RoomHarnessAgent, RoomParticipant } from '../../../shared/rooms'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter, RoomHarnessBinding } from './harness-adapter'
import {
  hideRoomParticipantRendererStatus,
  roomParticipantFieldsFromBinding,
  roomParticipantHarnessBinding
} from './participant-harness-binding'
import type { RoomTranscriptBridge } from './transcript-bridge'
import { stopRoomParticipantProcess } from './participant-room-stop'

export type RoomParticipantConnection =
  | { kind: 'new'; worktreeId: string }
  | {
      kind: 'existing'
      worktreeId: string
      terminalHandle?: string
      paneKey?: string
      historyId?: string
      conversationId?: string
    }

export class RoomParticipantMembership {
  private readonly pendingConnections = new Set<string>()

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
    machineStreaming?: boolean
    trusted?: boolean
  }): Promise<RoomParticipant> {
    const room = this.db.core.get(input.roomId)
    if (room.worktreeId && room.worktreeId !== input.connection.worktreeId) {
      throw new Error('room_worktree_mismatch')
    }
    if (getRepoIdFromWorktreeId(input.connection.worktreeId) !== room.projectId) {
      throw new Error('room_worktree_project_mismatch')
    }
    const adapter = this.adapters[input.agent]
    const connectionClaim = this.connectionClaim(input.agent, input.connection)
    if (connectionClaim && this.pendingConnections.has(connectionClaim)) {
      throw new Error('room_agent_already_in_room')
    }
    if (
      input.connection.kind === 'existing' &&
      this.connectionOwned(input.agent, input.connection)
    ) {
      throw new Error('room_agent_already_in_room')
    }
    if (connectionClaim) {
      this.pendingConnections.add(connectionClaim)
    }
    let binding: RoomHarnessBinding | null = null
    let added: RoomParticipant | null = null
    try {
      binding = await this.connect(adapter, input.connection, {
        machineStreaming: input.machineStreaming,
        trusted: input.trusted
      })
      let participant = this.db.participants.add({
        roomId: input.roomId,
        identity: input.identity,
        displayName: input.displayName,
        agent: input.agent,
        roleId: input.roleId,
        ...roomParticipantFieldsFromBinding(binding),
        processIncarnation: adapter.incarnation(binding),
        terminalSurfaceVisible:
          binding.transport !== 'machine' && binding.terminalSurfaceVisible === true
      })
      added = participant
      hideRoomParticipantRendererStatus(participant, this.hideRendererStatus)
      participant = this.db.participants.update(participant.id, { state: 'starting' })
      this.emit(input.roomId, { type: 'participant.updated', participant })
      await this.transcriptBridge.ensure(participant)
      return await this.waitUntilReady(participant, binding.disposition === 'created')
    } catch (error) {
      let failure = error
      if (added) {
        this.transcriptBridge.forgetParticipants([added.id])
        this.db.participants.remove(added.id)
        this.emit(added.roomId, { type: 'participant.removed', participantId: added.id })
      }
      if (binding?.disposition === 'created') {
        await adapter.stop(binding).catch((stopError) => {
          failure = new AggregateError([failure, stopError], 'room_agent_cleanup_failed')
        })
      }
      if (binding?.transport === 'machine' && binding.handoffFrom) {
        await adapter.restore(binding.handoffFrom).catch((restoreError) => {
          failure = new AggregateError([failure, restoreError], 'room_agent_handoff_restore_failed')
        })
      }
      throw failure
    } finally {
      if (connectionClaim) {
        this.pendingConnections.delete(connectionClaim)
      }
    }
  }

  async remove(id: string): Promise<void> {
    const participant = this.db.participants.get(id)
    const binding = roomParticipantHarnessBinding(participant)
    if (participant.agent && binding) {
      await stopRoomParticipantProcess(this.adapters[participant.agent], binding)
    }
    this.transcriptBridge.forgetParticipants([id])
    this.db.participants.remove(id)
    this.emit(participant.roomId, { type: 'participant.removed', participantId: id })
  }

  private async connect(
    adapter: RoomHarnessAdapter,
    connection: RoomParticipantConnection,
    options: { machineStreaming?: boolean; trusted?: boolean }
  ): Promise<RoomHarnessBinding> {
    if (connection.kind === 'new') {
      return adapter.launch(connection.worktreeId, options)
    }
    return adapter.connectExisting(connection, options)
  }

  private connectionClaim(
    agent: RoomHarnessAgent,
    connection: RoomParticipantConnection
  ): string | null {
    if (connection.kind !== 'existing') {
      return null
    }
    const family = agent === 'openclaude' ? 'claude' : agent
    const identity =
      connection.conversationId ?? connection.terminalHandle ?? connection.historyId ?? null
    return identity ? `${family}\0${connection.worktreeId}\0${identity}` : null
  }

  private connectionOwned(
    agent: RoomHarnessAgent,
    connection: Extract<RoomParticipantConnection, { kind: 'existing' }>
  ): boolean {
    return (
      this.db.participants.findOwner({
        agent,
        worktreeId: connection.worktreeId,
        terminalHandle: connection.terminalHandle,
        paneKey: connection.paneKey,
        ...(connection.conversationId
          ? {
              providerSession: {
                key: 'session_id',
                id: connection.conversationId,
                transport: 'machine'
              } as const
            }
          : {})
      }) !== null
    )
  }
}
