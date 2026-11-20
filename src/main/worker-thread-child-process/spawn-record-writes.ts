import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { threadId } from 'node:worker_threads'
import {
  ensurePrivateDirectory,
  findPrivateRuntimeDirectory
} from '../filesystem/private-runtime-directory'
import { SPAWN_KEY_PATTERN, SPAWN_RECORDS_DIR_NAME } from './lost-spawn-processes'
import { parseProcStat } from './proc-process-table'

/**
 * The launcher's record of each child: pid and start time. A pid posted to main dies with the
 * launcher while still in transit; a record does not, so main can still end that child (and its
 * group) after a crash, and the start time keeps a reused pid from ever being hit.
 */
export type SpawnRecords = {
  dir: string
  /** Before the spawn: an empty record says a child may exist from here on. */
  reserve(key: string): boolean
  /** False when no record could be written; main then falls back to the child's key. */
  write(key: string, pid: number): boolean
  remove(key: string): void
}

/** One private directory per worker, named by its process and thread; null when none can be made. */
export function openSpawnRecords(): SpawnRecords | null {
  const uid = process.getuid?.()
  const base = uid === undefined ? null : findPrivateRuntimeDirectory(SPAWN_RECORDS_DIR_NAME, uid)
  const dir = base && join(base, `${process.pid}-${threadId}`)
  if (!dir || uid === undefined || !ensurePrivateDirectory(dir, uid)) {
    return null
  }
  return {
    dir,
    reserve(key) {
      try {
        if (!SPAWN_KEY_PATTERN.test(key)) {
          return false
        }
        writeFileSync(join(dir, key), '', { mode: 0o600 })
        return true
      } catch {
        return false
      }
    },
    write(key, pid) {
      try {
        const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'latin1'))
        if (!stat || !SPAWN_KEY_PATTERN.test(key)) {
          return false
        }
        writeFileSync(join(dir, key), `${pid} ${stat.startTicks}`, { mode: 0o600 })
        return true
      } catch {
        return false
      }
    },
    remove(key) {
      if (SPAWN_KEY_PATTERN.test(key)) {
        try {
          unlinkSync(join(dir, key))
        } catch {
          // Already gone.
        }
      }
    }
  }
}
