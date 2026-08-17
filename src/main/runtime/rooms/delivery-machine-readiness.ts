import type { RoomDelivery, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter } from './harness-adapter'
import { roomParticipantHarnessBinding } from './participant-harness-binding'
import { roomDeliveryReadiness, type RoomReadyTarget } from './delivery-readiness-evidence'

export type RoomDeliveryReadinessProbe =
  | { kind: 'ready'; evidence: RoomReadyTarget }
  | { kind: 'recoverable' }
  | { kind: 'blocked' }

export async function probeRoomDeliveryReadiness(
  db: RoomDatabase,
  adapters: Record<string, RoomHarnessAdapter>,
  delivery: RoomDelivery
): Promise<RoomDeliveryReadinessProbe> {
  let participant: RoomParticipant
  try {
    participant = db.participants.get(delivery.participantId)
  } catch (error) {
    if (error instanceof Error && error.message === 'room_participant_not_found') {
      return { kind: 'blocked' }
    }
    throw error
  }
  if (participant.state === 'starting') {
    return { kind: 'blocked' }
  }
  const binding = roomParticipantHarnessBinding(participant)
  const adapter = participant.agent ? adapters[participant.agent] : undefined
  if (!adapter || !binding) {
    return { kind: 'blocked' }
  }
  const evidence = roomDeliveryReadiness(participant, binding)
  if (participant.state === 'sleeping') {
    return { kind: 'ready', evidence }
  }
  try {
    const status = await adapter.status(binding)
    if (!status.isRunningAgent) {
      return participant.state === 'error' ? { kind: 'ready', evidence } : { kind: 'recoverable' }
    }
    return status.status === 'idle' ? { kind: 'ready', evidence } : { kind: 'blocked' }
  } catch {
    // A failed wake must retry inside a claimed, counted delivery attempt.
    return participant.state === 'error' ? { kind: 'ready', evidence } : { kind: 'recoverable' }
  }
}

export async function claimReadyRoomDelivery(
  db: RoomDatabase,
  adapters: Record<string, RoomHarnessAdapter>,
  delivery: RoomDelivery,
  ensureReady: (participantId: string) => Promise<unknown>,
  claimAllowed: () => boolean
): Promise<RoomDelivery | null> {
  const initial = await probeRoomDeliveryReadiness(db, adapters, delivery)
  if (!claimAllowed()) {
    return null
  }
  if (initial.kind !== 'recoverable') {
    return initial.kind === 'ready' ? db.messages.deliveries.claim(delivery.id) : null
  }
  try {
    await ensureReady(delivery.participantId)
  } catch {
    return null
  }
  if (!claimAllowed()) {
    return null
  }
  const recovered = await probeRoomDeliveryReadiness(db, adapters, delivery)
  return claimAllowed() && recovered.kind === 'ready'
    ? db.messages.deliveries.claim(delivery.id)
    : null
}
