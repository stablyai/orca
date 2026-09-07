import { resolveOrchestrationMigrationStartVersion } from '../../orchestration-schema-version-skew'
import { SCHEMA_VERSION } from '../contract-constants'
import type { OrchestrationDb } from '../orchestration-db'
import { applySchemaMigrationsV13ToV30 } from './migrate-v13-v30'
import { applySchemaMigrationsV2ToV12 } from './migrate-v2-v12'
import { migrateMailboxPointerEnterV33 } from './migrate-mailbox-pointer-enter-v33'
import { migrateRoleMailboxDeliveryV34 } from './migrate-role-mailbox-delivery-v34'
import { migrateV35 } from './migrate-v35'
import { migrateV36 } from './migrate-v36'
import { migrateV37 } from './migrate-v37'
import { migrateV38 } from './migrate-v38'
import { migrateV39 } from './migrate-v39'

// Why: CREATE TABLE IF NOT EXISTS won't alter existing DBs; migrate in a txn that bumps user_version only on success (atomic all-or-nothing).
export function migrate(this: OrchestrationDb): void {
  const storedVersion = this.db.pragma('user_version', { simple: true }) as number
  const current = resolveOrchestrationMigrationStartVersion(this.db, storedVersion, SCHEMA_VERSION)
  if (current >= SCHEMA_VERSION) {
    return
  }

  this.db.exec('BEGIN IMMEDIATE')
  try {
    applySchemaMigrationsV2ToV12.call(this, current)
    applySchemaMigrationsV13ToV30.call(this, current)
    migrateMailboxPointerEnterV33.call(this, current)
    migrateRoleMailboxDeliveryV34.call(this, current)
    migrateV35.call(this, current)
    migrateV36.call(this, current)
    migrateV37.call(this, current)
    migrateV38.call(this, current)
    migrateV39.call(this, current)
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
    this.db.exec('COMMIT')
  } catch (err) {
    this.db.exec('ROLLBACK')
    throw err
  }
}

export type SchemaMigrateMethods = {
  migrate: typeof migrate
}

export function attachSchemaMigrate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    migrate
  })
}
