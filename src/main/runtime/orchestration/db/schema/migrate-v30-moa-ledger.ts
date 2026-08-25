import type { OrchestrationDb } from '../orchestration-db'
import { createMoaLedgerTablesSql } from './create-moa-ledger-tables-sql'

export function applySchemaMigrationV30MoaLedger(this: OrchestrationDb, current: number): void {
  if (current < 30) {
    this.db.exec(createMoaLedgerTablesSql())
  }
}
