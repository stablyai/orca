import type { OrchestrationDb } from '../orchestration-db'
import { createControlPlaneTablesSql } from '../../control-plane/control-plane-tables-sql'
import { createCoreTablesSql } from './create-core-tables-sql'
import { createGraphTablesSql } from './create-graph-tables-sql'

export function createTables(this: OrchestrationDb): void {
  this.db.exec(
    `${createCoreTablesSql()}\n${createGraphTablesSql()}\n${createControlPlaneTablesSql()}`
  )
  this.createMailboxDeliveryIndexesIfPossible()
}

export type CreateTablesMethods = {
  createTables: typeof createTables
}

export function attachCreateTables(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createTables
  })
}
