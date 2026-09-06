import type { RoomDatabase } from './database'

export function scheduleRoomDeliveryDrain(
  db: RoomDatabase,
  excludedRoomIds: readonly string[],
  busyRetryAt: number,
  isDisposed: boolean,
  timer: ReturnType<typeof setTimeout> | null,
  setTimer: (timer: ReturnType<typeof setTimeout>) => void,
  drain: () => void
): void {
  if (isDisposed || timer) {
    return
  }
  const nextDueAt = db.messages.deliveries.nextDueAt(excludedRoomIds)
  if (nextDueAt === null) {
    return
  }
  const delay = Math.min(
    2_147_000_000,
    Math.max(0, nextDueAt - Date.now(), busyRetryAt - Date.now())
  )
  const scheduled = setTimeout(() => drain(), delay)
  scheduled.unref?.()
  setTimer(scheduled)
}
