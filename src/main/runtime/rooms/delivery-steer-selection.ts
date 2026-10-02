import type { RoomDelivery } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter } from './harness-adapter'
import type { RoomHarnessBinding, RoomMachineHarnessBinding } from './harness-adapter-types'
import { roomParticipantHarnessBinding } from './participant-harness-binding'
import type { RoomBroadcastSteerTarget } from './delivery-broadcast-steer'
import type { RoomDeliveryFence } from './delivery-room-gate'

const sameMachineBinding = (
  current: RoomHarnessBinding | null,
  expected: RoomMachineHarnessBinding
): boolean =>
  current?.transport === 'machine' &&
  current.worktreeId === expected.worktreeId &&
  current.providerSession.key === expected.providerSession.key &&
  current.providerSession.id === expected.providerSession.id

export async function claimRoomSteer(
  db: RoomDatabase,
  adapters: Record<string, RoomHarnessAdapter>,
  id: string,
  group: boolean,
  claimAllowed: () => boolean = () => true
): Promise<{ roomId: string; deliveries: RoomDelivery[] }> {
  if (!claimAllowed()) {
    throw new Error('room_delivery_worker_disposed')
  }
  const candidate = db.messages.deliveries.get(id)
  if (candidate.state !== 'pending' || candidate.attempts !== 0) {
    throw new Error('room_delivery_queue_stale')
  }
  const roomId = db.messages.get(candidate.messageId).roomId
  const broadcast = db.messages.deliveries.isBroadcastMessage(candidate.messageId)
  if (group !== broadcast) {
    throw new Error('room_delivery_queue_stale')
  }
  if (!broadcast) {
    const participant = db.participants.get(candidate.participantId)
    const adapter = participant.agent ? adapters[participant.agent] : undefined
    const binding = roomParticipantHarnessBinding(participant)
    if (!adapter?.steer || !binding || binding.transport !== 'machine') {
      throw new Error('conversation_steer_unsupported')
    }
    const status = await adapter.status(binding)
    if (!claimAllowed()) {
      throw new Error('room_delivery_worker_disposed')
    }
    if (status.status !== 'working') {
      throw new Error('conversation_not_working')
    }
    const delivery = db.transaction(() => {
      const current = db.participants
        .list(roomId)
        .find((participant) => participant.id === candidate.participantId)
      const currentBinding = current ? roomParticipantHarnessBinding(current) : null
      return claimAllowed() &&
        current?.state === participant.state &&
        current.processIncarnation === participant.processIncarnation &&
        sameMachineBinding(currentBinding, binding)
        ? db.messages.deliveries.claimSteer(id)
        : null
    })
    if (!delivery) {
      throw new Error('room_delivery_queue_stale')
    }
    return { roomId, deliveries: [delivery] }
  }
  const active = db.participants
    .list(roomId)
    .filter(
      (participant) => participant.actorKind === 'agent' && participant.participation === 'active'
    )
  const pending = db.messages.deliveries.listForMessage(candidate.messageId)
  const steerIds: string[] = []
  const expectedTargets: RoomBroadcastSteerTarget[] = []
  for (const participant of active) {
    const delivery = pending.find((item) => item.participantId === participant.id)
    if (!delivery || delivery.state !== 'pending' || delivery.attempts !== 0) {
      throw new Error('room_delivery_queue_stale')
    }
    const adapter = participant.agent ? adapters[participant.agent] : undefined
    const binding = roomParticipantHarnessBinding(participant)
    if (!adapter?.steer || !binding || binding.transport !== 'machine') {
      throw new Error('conversation_steer_unsupported')
    }
    expectedTargets.push({
      participantId: participant.id,
      state: participant.state,
      processIncarnation: participant.processIncarnation,
      worktreeId: binding.worktreeId,
      providerSessionKey: binding.providerSession.key,
      providerSessionId: binding.providerSession.id
    })
    if (participant.state === 'sleeping') {
      continue
    }
    const status = await adapter.status(binding)
    if (!claimAllowed()) {
      throw new Error('room_delivery_worker_disposed')
    }
    if (status.status === 'working') {
      steerIds.push(participant.id)
    } else if (status.status !== 'idle') {
      throw new Error('conversation_not_working')
    }
  }
  const deliveries = claimAllowed()
    ? db.messages.deliveries.claimBroadcastSteer(candidate.messageId, expectedTargets, steerIds)
    : null
  if (!deliveries) {
    throw new Error('room_delivery_queue_stale')
  }
  return { roomId, deliveries }
}

export async function runRoomSteer(
  db: RoomDatabase,
  adapters: Record<string, RoomHarnessAdapter>,
  id: string,
  requestFence: (
    roomId: string,
    options: { discardConfirmations: boolean; waitForTasks?: boolean }
  ) => RoomDeliveryFence,
  deliver: (delivery: RoomDelivery, steer: boolean) => Promise<void>,
  track: (roomId: string, run: () => Promise<void>) => Promise<void>,
  group: boolean,
  waitForDelivery = true
): Promise<void> {
  const candidate = db.messages.deliveries.get(id)
  const roomId = db.messages.get(candidate.messageId).roomId
  const fence = requestFence(roomId, { discardConfirmations: false, waitForTasks: false })
  let completion: Promise<void[]>
  try {
    await fence.ready
    const targetIds = group
      ? db.participants
          .list(roomId)
          .filter(
            (participant) =>
              participant.actorKind === 'agent' && participant.participation === 'active'
          )
          .map((participant) => participant.id)
      : [candidate.participantId]
    if (
      targetIds.some((participantId) => db.messages.deliveries.delivering(participantId, 'steer'))
    ) {
      throw new Error('conversation_steer_busy')
    }
    const claimed = await claimRoomSteer(db, adapters, id, group, fence.claimAllowed)
    // Register every delivery before releasing admission, so Stop/delete still drain them.
    completion = Promise.all(
      claimed.deliveries.map((delivery) =>
        track(roomId, () => deliver(delivery, delivery.intent === 'steer'))
      )
    )
  } finally {
    fence.release()
  }
  if (waitForDelivery) {
    await completion
  } else {
    // Automatic failures are persisted by deliver and rescheduled by track.
    void completion.catch(() => {})
  }
}
