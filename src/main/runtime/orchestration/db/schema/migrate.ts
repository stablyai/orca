import { resolveOrchestrationMigrationStartVersion } from '../../orchestration-schema-version-skew'
import { SCHEMA_VERSION } from '../contract-constants'
import type { OrchestrationDb } from '../orchestration-db'
import { applySchemaMigrationsV13ToV29 } from './migrate-v13-v29'
import { applySchemaMigrationsV2ToV12 } from './migrate-v2-v12'

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
    applySchemaMigrationsV13ToV29.call(this, current)
    if (current < 30) {
      if (!this.hasColumn('messages', 'delivery_state')) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'none'`)
      }
      this.db.exec(`
        UPDATE messages
        SET delivery_state = CASE
          WHEN delivered_at IS NULL THEN 'none'
          ELSE 'delivered'
        END
        WHERE delivery_state = 'none' AND delivered_at IS NOT NULL
      `)
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_delivery_state
          ON messages(to_handle, read, delivery_state, sequence)
      `)
    }
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
