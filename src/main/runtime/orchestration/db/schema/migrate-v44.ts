import type { OrchestrationDb } from '../orchestration-db'

export function migrateV44(this: OrchestrationDb, current: number): void {
  if (current < 44 && !this.hasColumn('deliveries', 'sweep_end_sequence')) {
    this.db.exec('ALTER TABLE deliveries ADD COLUMN sweep_end_sequence INTEGER')
  }
}
