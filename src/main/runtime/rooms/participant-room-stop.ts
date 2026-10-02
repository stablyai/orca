import type { RoomHarnessAgent } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter, RoomHarnessBinding } from './harness-adapter'
import { roomParticipantHarnessBinding } from './participant-harness-binding'
import type { RoomTranscriptBridge } from './transcript-bridge'

export async function stopRoomParticipants(
  roomId: string,
  db: RoomDatabase,
  adapters: Record<RoomHarnessAgent, RoomHarnessAdapter>,
  transcriptBridge: RoomTranscriptBridge
): Promise<() => void> {
  const participants = db.participants.list(roomId)
  const stops = await Promise.allSettled(
    participants.map(async (participant) => {
      const binding = roomParticipantHarnessBinding(participant)
      if (participant.agent && binding && participant.state !== 'sleeping') {
        await stopRoomParticipantProcess(adapters[participant.agent], binding)
      }
    })
  )
  const failed = stops.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  if (failed) {
    throw failed.reason
  }
  participants.forEach((participant) => transcriptBridge.disposeParticipant(participant.id))
  const participantIds = participants.map((participant) => participant.id)
  return () => transcriptBridge.forgetParticipants(participantIds)
}

export async function stopRoomParticipantProcess(
  adapter: Pick<RoomHarnessAdapter, 'stop' | 'locate'>,
  binding: RoomHarnessBinding
): Promise<void> {
  const stopped = await adapter
    .stop(binding)
    .then((result) => result.ptyKilled)
    .catch(() => false)
  if (!stopped && (await adapter.locate(binding))) {
    throw new Error('room_agent_stop_unconfirmed')
  }
}
