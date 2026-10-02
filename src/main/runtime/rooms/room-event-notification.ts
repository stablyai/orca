import type { RoomEvent } from '../../../shared/rooms'
import { isRecord } from '../../../shared/agent-status-child-work-value-guards'
import type { RoomDatabase } from './database'

export function addRoomMessageNotificationContext<T extends RoomEvent>(
  db: RoomDatabase,
  roomId: string,
  event: T
): T {
  if (
    event.type !== 'message.created' ||
    event.message.actorKind !== 'agent' ||
    (isRecord(event.message.metadata.activity) &&
      event.message.metadata.activity.state === 'interrupted')
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
