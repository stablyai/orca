import type { OrchestrationDb } from '../orchestration-db'
import { createCoreTablesSql } from './create-core-tables-sql'
import { createGraphTablesSql } from './create-graph-tables-sql'
import { createMaestroTablesSql } from './create-maestro-tables-sql'
import { createMaestroTerminalLeaseTablesSql } from './create-maestro-terminal-lease-tables-sql'
import { createMaestroBrowserSurfaceTablesSql } from './create-maestro-browser-surface-tables-sql'

export function createTables(this: OrchestrationDb): void {
  this.db.exec(
    `${createCoreTablesSql()}\n${createGraphTablesSql()}\n${createMaestroTablesSql()}\n${createMaestroTerminalLeaseTablesSql()}\n${createMaestroBrowserSurfaceTablesSql()}`
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
