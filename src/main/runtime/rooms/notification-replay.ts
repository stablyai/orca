import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomMessage, RoomNotificationReplayPage } from '../../../shared/rooms'
import { hydrateRoomMessages } from './message-queries'
import type { RoomDatabase } from './database'
import { addRoomMessageNotificationContext } from './room-event-notification'
import type { RoomRow } from './rows'

export class RoomNotificationReplayStore {
  constructor(private readonly db: SyncDatabase.Database) {}

  list(
    afterSequence: number | null,
    limit: number
  ): {
    messages: RoomMessage[]
    cursor: number
    hasMore: boolean
  } {
    const boundedLimit = Math.min(Math.max(limit, 1), 200)
    if (afterSequence === null) {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM room_messages')
        .get() as RoomRow
      return { messages: [], cursor: Number(row.sequence), hasMore: false }
    }
    const rows = this.db
      .prepare('SELECT * FROM room_messages WHERE sequence > ? ORDER BY sequence ASC LIMIT ?')
      .all(afterSequence, boundedLimit + 1) as RoomRow[]
    const pageRows = rows.slice(0, boundedLimit)
    return {
      messages: hydrateRoomMessages(
        this.db,
        pageRows.filter((row) => row.actor_kind === 'agent' && row.deleted_at === null)
      ),
      cursor: pageRows.length > 0 ? Number(pageRows.at(-1)!.sequence) : afterSequence,
      hasMore: rows.length > boundedLimit
    }
  }
}

export function replayRoomNotifications(
  db: RoomDatabase,
  afterSequence: number | null,
  limit: number
): RoomNotificationReplayPage {
  const page = db.notificationReplay.list(afterSequence, limit)
  return {
    ...page,
    events: page.messages.map((message) =>
      addRoomMessageNotificationContext(db, message.roomId, {
        type: 'message.created',
        message
      })
    ) as RoomNotificationReplayPage['events']
  }
}
