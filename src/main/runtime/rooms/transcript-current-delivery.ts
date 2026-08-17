import type { RoomDatabase } from './database'

export function currentRoomTurnDeliveryIdForConversation(
  db: RoomDatabase,
  watchers: Iterable<[string, { sessionId: string }]>,
  activeDeliveries: ReadonlyMap<string, string | null>,
  conversationId: string
): string | null {
  let currentId: string | null = null
  let currentDeliveredAt = 0
  for (const [participantId, watcher] of watchers) {
    const deliveryId = activeDeliveries.get(participantId)
    if (watcher.sessionId !== conversationId || !deliveryId) {
      continue
    }
    try {
      const delivery = db.messages.deliveries.get(deliveryId)
      if ((delivery.deliveredAt ?? 0) > currentDeliveredAt) {
        currentId = delivery.id
        currentDeliveredAt = delivery.deliveredAt ?? 0
      }
    } catch {
      continue
    }
  }
  return currentId
}
