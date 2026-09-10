import type { OrchestrationDb } from '../orchestration-db'
import { createMaestroBrowserSurfaceTablesSql } from './create-maestro-browser-surface-tables-sql'

export function applySchemaMigrationV44(this: OrchestrationDb, current: number): void {
  if (current >= 44) {
    return
  }
  this.db.exec(createMaestroBrowserSurfaceTablesSql())
}
