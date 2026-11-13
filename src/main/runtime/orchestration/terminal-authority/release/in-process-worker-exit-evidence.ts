import { parseWorkerTerminalHostScope } from '../../../../../shared/orchestration/workers/worker-terminal-host-scope'
import type { OrchestrationDb } from '../../db/orchestration-db'

/**
 * Exits this process's own in-process PTY provider observed for workers still awaiting release.
 * Its live inventory forgets a PTY at exit, so absence alone cannot tell "exited here" from "owned elsewhere".
 */
export class InProcessWorkerExitEvidence {
  private readonly exited = new Set<string>()

  record(db: OrchestrationDb | null, processIncarnation: string): void {
    if (!db) {
      return
    }
    this.prune(db)
    if (hasUnreleasedLocalWorker(db, processIncarnation)) {
      this.exited.add(processIncarnation)
    }
  }

  has(db: OrchestrationDb | null, processIncarnation: string): boolean {
    if (!db) {
      return false
    }
    this.prune(db)
    return this.exited.has(processIncarnation)
  }

  get size(): number {
    return this.exited.size
  }

  // Release, transfer and removal all end the obligation; whichever path ended it, drop the proof.
  private prune(db: OrchestrationDb): void {
    for (const processIncarnation of this.exited) {
      if (!hasUnreleasedLocalWorker(db, processIncarnation)) {
        this.exited.delete(processIncarnation)
      }
    }
  }
}

function hasUnreleasedLocalWorker(db: OrchestrationDb, processIncarnation: string): boolean {
  const rows = db.db
    .prepare(
      `SELECT host_scope FROM worker_terminal_resources
        WHERE process_incarnation = ? AND ownership_state = 'owned' AND release_state <> 'released'`
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT names exactly this one nullable TEXT column.
    .all(processIncarnation) as { host_scope: string | null }[]
  return rows.some((row) => {
    const scope = parseWorkerTerminalHostScope(row.host_scope)
    return scope !== null && scope.kind !== 'ssh'
  })
}
