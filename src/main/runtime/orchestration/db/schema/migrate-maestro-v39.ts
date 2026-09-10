import type { OrchestrationDb } from '../orchestration-db'
import { createMaestroTablesSql } from './create-maestro-tables-sql'

export function applySchemaMigrationV39(this: OrchestrationDb, current: number): void {
  if (current < 39) {
    this.db.exec(createMaestroTablesSql())
  }
}
