import type { RoomEvent, RoomHarnessAgent, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter } from './harness-adapter'
import { roomParticipantHarnessBinding } from './participant-harness-binding'
import { updateRoomParticipantStatus } from './participant-status'

export async function waitForRoomParticipantReady(
  db: RoomDatabase,
  adapters: Record<RoomHarnessAgent, RoomHarnessAdapter>,
  emit: (roomId: string, event: RoomEvent) => void,
  participant: RoomParticipant,
  requireInputReady = false
): Promise<RoomParticipant> {
  const adapter = participant.agent ? adapters[participant.agent] : null
  const binding = roomParticipantHarnessBinding(participant)
  if (!adapter || !binding) {
    throw new Error('room_agent_not_attached')
  }
  let inputReady = !requireInputReady || (await adapter.awaitInputReady(binding))
  const current = await adapter.status(binding).catch(() => null)
  if (current?.isRunningAgent) {
    if (current.status === 'permission') {
      throw new Error('room_agent_permission')
    }
    if (current.status === 'idle') {
      if (!inputReady && !(await adapter.awaitInputReady(binding))) {
        throw new Error('room_agent_not_ready')
      }
      return updateRoomParticipantStatus(db, adapters, emit, participant, true, current.status)
    }
    if (
      requireInputReady &&
      current.status === null &&
      (inputReady || (await adapter.awaitInputReady(binding)))
    ) {
      return updateRoomParticipantStatus(db, adapters, emit, participant, true, current.status)
    }
  }
  const wait = await adapter.awaitReady(binding)
  if (!wait.satisfied) {
    throw new Error(wait.blockedReason ? 'room_agent_permission' : 'room_agent_not_ready')
  }
  if (!inputReady) {
    inputReady = await adapter.awaitInputReady(binding)
    if (!inputReady) {
      throw new Error('room_agent_not_ready')
    }
  }
  const status = await adapter.status(binding)
  const startupComposerReady =
    requireInputReady && inputReady && (status.status === null || status.status === 'working')
  if (!status.isRunningAgent || (status.status !== 'idle' && !startupComposerReady)) {
    if (status.status === 'permission') {
      throw new Error('room_agent_permission')
    }
    throw new Error('room_agent_not_ready')
  }
  return updateRoomParticipantStatus(db, adapters, emit, participant, true, 'idle')
}
