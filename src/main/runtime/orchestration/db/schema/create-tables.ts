import type { OrchestrationDb } from '../orchestration-db'
import { createCoreTablesSql } from './create-core-tables-sql'
import { createGraphTablesSql } from './create-graph-tables-sql'
import { DERIVED_DELIVERY_SCHEMA_SQL } from './migrate-v41'
import { REMOVED_WORK_SCHEMA_SQL } from '../reset/removed-orchestration-work-store'
import { PEER_RUN_SCHEMA_SQL } from '../peer-runs/peer-run-queue-sql'

export function createTables(this: OrchestrationDb): void {
  this.db.exec(
    `${createCoreTablesSql()}\n${createGraphTablesSql()}\n${REMOVED_WORK_SCHEMA_SQL}\n${PEER_RUN_SCHEMA_SQL}`
  )
  // Unreleased builds saved each send's fence as NOT NULL; nothing reads it, and new rows carry none.
  if (this.hasColumn('structured_mail_sends', 'fence')) {
    this.db.exec('ALTER TABLE structured_mail_sends DROP COLUMN fence')
  }
  this.createMailboxDeliveryIndexesIfPossible()
  this.db.exec(DERIVED_DELIVERY_SCHEMA_SQL)
}

export type CreateTablesMethods = {
  createTables: typeof createTables
}

export function attachCreateTables(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createTables
  })
}
