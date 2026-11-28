// Exclusive per-checkout locks on SQLite's file locking. The OS drops a lock when its process
// exits, even on a crash, so no lock can go stale and none is ever reclaimed by another process.
import { DatabaseSync } from 'node:sqlite'

// Exit code of a fixture server that found another server owning this checkout.
export const SERVER_BUSY_EXIT_CODE = 75

const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6

/** Returns a held lock, or null if another connection still holds it after waitMs. */
export function tryHoldLock(file, waitMs = 0) {
  const db = new DatabaseSync(file)
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))}`)
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    db.close()
    if (error?.errcode === SQLITE_BUSY || error?.errcode === SQLITE_LOCKED) {
      return null
    }
    throw error
  }
  let held = true
  return {
    release() {
      if (!held) {
        return
      }
      held = false
      try {
        db.exec('ROLLBACK')
      } finally {
        db.close()
      }
    }
  }
}
