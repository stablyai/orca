import type { RoomDelivery } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import { assertCurrentRoomDelivery } from './delivery-current-guard'

export function deliveryFailureState(exhausted: boolean): RoomDelivery['state'] {
  return exhausted ? 'failed' : 'pending'
}

export function deferPausedDelivery(db: RoomDatabase, delivery: RoomDelivery): RoomDelivery | null {
  const deferred = db.messages.deliveries.deferPaused(delivery)
  if (!deferred) {
    assertCurrentRoomDelivery(db, delivery)
  }
  return deferred
}
