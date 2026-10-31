import type { OrchestrationDb } from '../orchestration-db'
import { createCoreTablesSql } from './create-core-tables-sql'
import { createGraphTablesSql } from './create-graph-tables-sql'
import { DERIVED_DELIVERY_SCHEMA_SQL } from './migrate-v41'
import { REMOVED_WORK_SCHEMA_SQL } from '../reset/removed-orchestration-work-store'
import { AGENT_SENDER_IDENTITIES_SQL } from '../messages/agent-sender-identity-store'

export function createTables(this: OrchestrationDb): void {
  // New tables need no version bump: older builds open the database unchanged and ignore them.
  this.db.exec(
    `${createCoreTablesSql()}\n${createGraphTablesSql()}\n${REMOVED_WORK_SCHEMA_SQL}\n${AGENT_SENDER_IDENTITIES_SQL}`
  )
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
