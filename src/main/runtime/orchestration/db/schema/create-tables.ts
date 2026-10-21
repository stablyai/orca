import type { OrchestrationDb } from '../orchestration-db'
import { createCoreTablesSql } from './create-core-tables-sql'
import { createGraphTablesSql } from './create-graph-tables-sql'
import { DERIVED_DELIVERY_SCHEMA_SQL } from './migrate-v41'

export function createTables(this: OrchestrationDb): void {
  this.db.exec(`${createCoreTablesSql()}\n${createGraphTablesSql()}`)
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
