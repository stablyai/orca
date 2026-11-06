import type { OrchestrationDb } from '../orchestration-db'

/** The launch recipe a closed worker's reopen replays, recorded from what Orca itself launched (#37693). */
export function migrateV47(this: OrchestrationDb, current: number): void {
  if (current >= 47) {
    return
  }
  if (!this.hasColumn('worker_terminal_resources', 'launch_recipe')) {
    this.db.exec('ALTER TABLE worker_terminal_resources ADD COLUMN launch_recipe TEXT')
  }
}
