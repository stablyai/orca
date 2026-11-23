import { parseWorkerTerminalHostScope } from '../../../../../shared/orchestration/workers/worker-terminal-host-scope'
import type { OrchestrationDb } from '../../db/orchestration-db'

// Each operation also rechecks this many held proofs, so ended obligations drain without a full scan.
const CLEANUP_STEPS_PER_OPERATION = 2

/**
 * Exits this process's own in-process PTY provider observed for workers still awaiting release.
 * Its live inventory forgets a PTY at exit, so absence alone cannot tell "exited here" from "owned elsewhere".
 */
export class InProcessWorkerExitEvidence {
  private readonly exited = new Set<string>()
  private cleanup: Iterator<string> | null = null

  record(db: OrchestrationDb | null, processIncarnation: string): void {
    if (!db) {
      return
    }
    if (hasUnreleasedLocalWorker(db, processIncarnation)) {
      this.exited.add(processIncarnation)
    }
    this.advanceCleanup(db)
  }

  has(db: OrchestrationDb | null, processIncarnation: string): boolean {
    if (!db) {
      return false
    }
    let held = this.exited.has(processIncarnation)
    if (held && !hasUnreleasedLocalWorker(db, processIncarnation)) {
      this.exited.delete(processIncarnation)
      held = false
    }
    this.advanceCleanup(db)
    return held
  }

  // Release, transfer and removal all end the obligation; whichever path ended it, drop the proof.
  private advanceCleanup(db: OrchestrationDb): void {
    for (let step = 0; step < CLEANUP_STEPS_PER_OPERATION && this.exited.size > 0; step++) {
      let next = this.cleanup?.next()
      if (!next || next.done) {
        this.cleanup = this.exited.values()
        next = this.cleanup.next()
      }
      if (!next.done && !hasUnreleasedLocalWorker(db, next.value)) {
        this.exited.delete(next.value)
      }
    }
  }
}

function hasUnreleasedLocalWorker(db: OrchestrationDb, processIncarnation: string): boolean {
  return db.db
    .prepare(
      `SELECT host_scope FROM worker_terminal_resources
        WHERE process_incarnation = ? AND ownership_state = 'owned' AND release_state <> 'released'`
    )
    .all(processIncarnation)
    .some((row) => {
      const hostScope = row.host_scope
      const scope =
        typeof hostScope === 'string' || hostScope === null
          ? parseWorkerTerminalHostScope(hostScope)
          : null
      return scope !== null && scope.kind !== 'ssh'
    })
}
