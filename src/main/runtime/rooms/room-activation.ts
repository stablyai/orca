import type { RoomParticipant } from '../../../shared/rooms'
import type { RoomParticipantController } from './participant-controller'
import type { RoomTranscriptBridge } from './transcript-bridge'

export async function activateRoomParticipants(
  participants: readonly RoomParticipant[],
  controller: RoomParticipantController,
  transcript: RoomTranscriptBridge,
  publishSession: (participant: RoomParticipant) => void
): Promise<void> {
  await Promise.all(
    participants
      .filter((participant) => participant.actorKind === 'agent')
      .map(async (participant) => {
        // One unrecoverable agent must not block activating the rest of the room.
        try {
          const reconciled = await controller.reconcile(participant)
          if (reconciled.state !== 'sleeping' && reconciled.state !== 'offline') {
            publishSession(reconciled)
            await transcript.ensure(reconciled)
            await transcript.refreshContext(reconciled)
          }
        } catch {}
      })
  )
}
