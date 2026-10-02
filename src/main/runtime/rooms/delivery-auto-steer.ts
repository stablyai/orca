import type { RoomDelivery } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter } from './harness-adapter'
import type { RoomDeliveryFence } from './delivery-room-gate'
import { runRoomSteer } from './delivery-steer-selection'

export async function runRoomAutoSteer(
  db: RoomDatabase,
  adapters: Record<string, RoomHarnessAdapter>,
  excludedRoomIds: readonly string[],
  requestFence: (
    roomId: string,
    options: { discardConfirmations: boolean; waitForTasks?: boolean }
  ) => RoomDeliveryFence,
  deliver: (delivery: RoomDelivery, steer: boolean) => Promise<void>,
  track: (roomId: string, run: () => Promise<void>) => Promise<void>
): Promise<{ claimedAny: boolean; busyCandidate: boolean }> {
  let claimedAny = false
  let busyCandidate = false
  for (const candidate of db.messages.deliveries.listAutoSteerDue(
    Date.now(),
    100,
    excludedRoomIds
  )) {
    try {
      await runRoomSteer(db, adapters, candidate.id, requestFence, deliver, track, false, false)
      claimedAny = true
    } catch {
      busyCandidate = true
    }
  }
  return { claimedAny, busyCandidate }
}
