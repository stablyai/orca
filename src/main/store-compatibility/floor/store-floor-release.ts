import positionalInsertTables from './1.4.263-positional-insert-tables.json'
import floorSchemas from './1.4.263-store-schemas.json'
import reviewedFloorTableTriggers from './reviewed-floor-table-triggers.json'

/** The oldest release a user can downgrade to and back from without loss; raise it only at a release. */
export const STORE_FLOOR = {
  release: '1.4.263',
  commit: '131f209f770',
  daemonProtocolVersion: 57,
  agentSessionRecordSchemaVersion: 2,
  schemas: floorSchemas,
  positionalInsertTables,
  reviewedFloorTableTriggers
} as const
