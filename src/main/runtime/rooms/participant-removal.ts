import type { RoomParticipant } from '../../../shared/rooms'
import type { RoomParticipantMembership } from './participant-membership'

export function beginParticipantRemoval(
  id: string,
  removals: Map<string, Promise<void>>,
  restore: Promise<RoomParticipant> | undefined,
  membership: RoomParticipantMembership
): Promise<void> {
  const active = removals.get(id)
  if (active) {
    return active
  }
  const removal = Promise.resolve()
    .then(async () => {
      await restore?.catch(() => {})
      await membership.remove(id)
    })
    .finally(() => removals.delete(id))
  removals.set(id, removal)
  return removal
}

export async function waitForParticipantRemoval(removal: Promise<void>): Promise<never> {
  await removal
  throw new Error('room_participant_not_found')
}
