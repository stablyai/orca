import type { OrchestrationDb } from '../orchestration-db'
import { createMaestroTerminalLeaseTablesSql } from './create-maestro-terminal-lease-tables-sql'

export function applySchemaMigrationV40(this: OrchestrationDb, current: number): void {
  if (current < 40) {
    this.db.exec(createMaestroTerminalLeaseTablesSql())
  }
}
