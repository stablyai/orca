import type { RoomDelivery } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter } from './harness-adapter'
import { probeRoomDeliveryReadiness } from './delivery-machine-readiness'

export async function claimReadyRoomBroadcast(
  db: RoomDatabase,
  adapters: Record<string, RoomHarnessAdapter>,
  messageId: string,
  ensureReady: (participantId: string) => Promise<unknown>,
  claimAllowed: () => boolean
): Promise<RoomDelivery[] | null> {
  const group = db.messages.deliveries
    .listForMessage(messageId)
    .filter((delivery) => db.participants.get(delivery.participantId).participation === 'active')
  let probes = await Promise.all(
    group.map((delivery) => probeRoomDeliveryReadiness(db, adapters, delivery))
  )
  if (!claimAllowed() || probes.some(({ kind }) => kind === 'blocked')) {
    return null
  }
  const recoverable = probes.flatMap((probe, index) =>
    probe.kind === 'recoverable' ? [group[index]!] : []
  )
  if (recoverable.length > 0) {
    const restored = await Promise.allSettled(
      recoverable.map((delivery) => ensureReady(delivery.participantId))
    )
    if (!claimAllowed() || restored.some(({ status }) => status === 'rejected')) {
      return null
    }
    probes = await Promise.all(
      group.map((delivery) => probeRoomDeliveryReadiness(db, adapters, delivery))
    )
  }
  const readiness = probes.flatMap((probe) => (probe.kind === 'ready' ? [probe.evidence] : []))
  if (readiness.length !== group.length) {
    return null
  }
  return claimAllowed() ? db.messages.deliveries.claimBroadcast(messageId, readiness) : null
}
