import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import { WSL_MOVE_SLEPT_SPOOL_DIR } from './wsl-move-slept-scrollback'

/**
 * At startup, before any move runs: spools of moves the journal no longer holds. A run killed
 * mid-pause is reset without its process, so it never disposed of its documents.
 */
export function sweepOrphanedWslMoveSleptSpools(userDataPath: string): void {
  let live: Set<string>
  let names: string[]
  try {
    live = new Set(listWslMoveCutovers(userDataPath).map((cutover) => cutover.migrationId))
    names = readdirSync(join(userDataPath, WSL_MOVE_SLEPT_SPOOL_DIR))
  } catch {
    // An unreadable journal could still name one; a missing folder holds nothing.
    return
  }
  for (const name of names) {
    if (!live.has(name)) {
      rmSync(join(userDataPath, WSL_MOVE_SLEPT_SPOOL_DIR, name), { recursive: true, force: true })
    }
  }
}
