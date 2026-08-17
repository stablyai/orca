import type { RoomEvent } from '../../../shared/rooms'
import type { RoomDatabase } from './database'

export function addRoomMessageNotificationContext(
  db: RoomDatabase,
  roomId: string,
  event: RoomEvent
): RoomEvent {
  if (
    event.type !== 'message.created' ||
    event.message.actorKind !== 'agent' ||
    (event.message.metadata.activity as { state?: unknown } | undefined)?.state === 'interrupted'
  ) {
    return event
  }
  const room = db.core.get(roomId)
  const participant = event.message.senderId ? db.participants.get(event.message.senderId) : null
  return {
    ...event,
    notification: {
      roomName: room.name,
      worktreeId: participant?.worktreeId ?? room.worktreeId,
      paneKey: participant?.paneKey ?? null,
      agent: participant?.agent ?? null
    }
  }
}
