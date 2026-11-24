import { mkdirSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const slotDirectory = path.join(homedir(), '.cache', 'orca', 'preflight')
const slotFile = path.join(slotDirectory, `${hostname()}.sqlite`)

export async function acquireChangedCheckSlot(file = slotFile) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  let announced = false
  try {
    for (;;) {
      try {
        // SQLite releases the write lock even when a check is killed.
        db.exec('BEGIN IMMEDIATE')
        return () => db.close()
      } catch (error) {
        if (error.errcode !== 5) {
          throw error
        }
        if (!announced) {
          console.log('Waiting for another local check:changed run to finish…')
          announced = true
        }
        await delay(1000 + Math.random() * 1000)
      }
    }
  } catch (error) {
    db.close()
    throw error
  }
}
