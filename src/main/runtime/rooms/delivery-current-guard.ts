import type { RoomDelivery } from '../../../shared/rooms'
import type { RoomDatabase } from './database'

export function assertCurrentRoomDelivery(db: RoomDatabase, delivery: RoomDelivery): void {
  const current = db.messages.deliveries.get(delivery.id)
  if (current.state !== 'delivering' || current.attempts !== delivery.attempts) {
    throw new Error('room_delivery_stopped')
  }
}

export function isRoomDeliveryMissing(db: RoomDatabase, id: string): boolean {
  try {
    db.messages.deliveries.get(id)
    return false
  } catch (error) {
    if (error instanceof Error && error.message === 'room_delivery_not_found') {
      return true
    }
    throw error
  }
}
