import { describe, expect, it } from 'vitest'
import {
  requireSchemaLockTarget,
  schemaLockTarget,
  sqlWithoutComments,
  takesRelationLock,
  type SchemaLockTarget
} from '@orca-cloud/postgres-schema'
import { relayPostgresSchemaStatements } from './database.js'

// Golden pin of every boot-time statement that takes a relation lock on Postgres. Each entry with
// a kind is gated by the catalog pre-check, so it costs a catalog read on a migrated database and
// nothing more. An addition to this list is the case the RULE comment beside SCHEMA forbids: a
// brand-new index reports missing on every director at once and each one runs a non-concurrent
// build over the whole table, which is how a boot takes the site down. Build it out of band with
// CREATE INDEX CONCURRENTLY first, then add it to SCHEMA and update this list.
const GOLDEN_LOCK_TAKING: SchemaLockTarget[] = [
  { kind: 'index', table: 'relay_invites', name: 'relay_invites_device', skipWhen: 'present' },
  { kind: 'index', table: 'relay_devices', name: 'relay_devices_current_hash', skipWhen: 'present' },
  { kind: 'index', table: 'relay_devices', name: 'relay_devices_grace_hash', skipWhen: 'present' },
  { kind: 'index', table: 'relay_connection_bases', name: 'relay_connection_bases_active_deadline', skipWhen: 'present' },
  {
    kind: 'index',
    table: 'relay_assignment_region_preferences',
    name: 'relay_assignment_region_preferences_observed',
    skipWhen: 'present'
  },
  {
    kind: 'index',
    table: 'relay_region_rehome_attempts',
    name: 'relay_region_rehome_attempts_pending',
    skipWhen: 'present'
  },
  {
    kind: 'index',
    table: 'relay_region_rehome_attempts',
    name: 'relay_region_rehome_attempts_host_recency',
    skipWhen: 'present'
  },
  { kind: 'index', table: 'relay_cell_runtime', name: 'relay_cell_runtime_heartbeat', skipWhen: 'present' },
  {
    kind: 'index',
    table: 'relay_cell_connection_runtime',
    name: 'relay_cell_connection_runtime_heartbeat',
    skipWhen: 'present'
  },
  {
    kind: 'index',
    table: 'relay_cell_connection_snapshots',
    name: 'relay_cell_connection_snapshot_freshness',
    skipWhen: 'present'
  },
  { kind: 'index', table: 'relay_cell_fences', name: 'relay_cell_fences_expiry', skipWhen: 'present' },
  { kind: 'index', table: 'relay_cell_committed_fences', name: 'relay_cell_committed_fences_expiry', skipWhen: 'present' },
  {
    kind: 'index',
    table: 'relay_cell_legacy_fence_adoptions',
    name: 'relay_cell_legacy_fence_adoptions_expiry',
    skipWhen: 'present'
  },
  { kind: 'index', table: 'relay_cell_fence_attempts', name: 'relay_cell_fence_attempts_expiry', skipWhen: 'present' },
  { kind: 'index', table: 'relay_cell_fence_attempts', name: 'relay_cell_fence_attempts_cell', skipWhen: 'present' },
  {
    kind: 'index',
    table: 'relay_cell_fence_apply_invocations',
    name: 'relay_cell_fence_apply_invocations_attempt',
    skipWhen: 'present'
  },
  {
    kind: 'index',
    table: 'relay_cell_drain_attempt_states',
    name: 'relay_cell_drain_attempt_states_cell',
    skipWhen: 'present'
  },
  {
    kind: 'index',
    table: 'relay_assignment_activity_leases',
    name: 'relay_assignment_activity_expiry',
    skipWhen: 'present'
  },
  {
    kind: 'index',
    table: 'relay_control_connection_reservations',
    name: 'relay_control_connection_reservation_headroom',
    skipWhen: 'present'
  },
  {
    kind: 'index',
    table: 'relay_control_connection_reservations',
    name: 'relay_control_connection_reservation_assignment',
    skipWhen: 'present'
  },
  { kind: 'index', table: 'relay_assignment_migrations', name: 'relay_assignment_migrations_active', skipWhen: 'present' },
  {
    kind: 'index',
    table: 'relay_post_drain_migration_pins',
    name: 'relay_post_drain_migration_pins_attempt',
    skipWhen: 'present'
  },
  { kind: 'index', table: 'relay_audit_events', name: 'relay_audit_events_at', skipWhen: 'present' },
  { kind: 'column', table: 'relay_region_decisions', name: 'last_considered_at', skipWhen: 'present' },
  { kind: 'column', table: 'relay_region_decisions', name: 'cohort_bucket', skipWhen: 'present' },
  // Constraint swaps are matched by name in pg_constraint, with opposite polarities: nothing to
  // drop is nothing to do, and a name already there is nothing to add.
  {
    kind: 'constraint',
    table: 'relay_region_rehome_attempts',
    name: 'relay_region_rehome_attempts_preferred_region_check',
    skipWhen: 'absent'
  },
  {
    kind: 'constraint',
    table: 'relay_region_rehome_attempts',
    name: 'relay_region_rehome_attempts_preferred_region_valid',
    skipWhen: 'present'
  },
  { kind: 'column', table: 'relay_region_rehome_control', name: 'host_cooldown_ms', skipWhen: 'present' },
  { kind: 'column', table: 'relay_control_capabilities', name: 'idle_regional_rehome', skipWhen: 'present' },
  { kind: 'column', table: 'relay_region_rehome_attempts', name: 'source_generation', skipWhen: 'present' }
]

const INDEX_OR_ADD_COLUMN = /^(?:CREATE\s+(?:UNIQUE\s+)?INDEX|ALTER\s+TABLE\s+[^\s]+\s+ADD\s+COLUMN)/i

function lockTakingStatements(): string[] {
  return relayPostgresSchemaStatements().filter(takesRelationLock)
}

describe('relay boot-time lock targets', () => {
  it('matches the pinned list of lock-taking statements', () => {
    expect(lockTakingStatements().map(schemaLockTarget)).toEqual(GOLDEN_LOCK_TAKING)
  })

  it('derives a target for every CREATE INDEX and every ALTER TABLE ADD COLUMN', () => {
    // A census over the real schema, not two hand-picked cases: a statement that lands here
    // without a target is sent on every boot and takes the lock the pre-check exists to avoid.
    // requireSchemaLockTarget is what boot calls, so this fails the same way boot would.
    for (const statement of relayPostgresSchemaStatements()) {
      expect(() => requireSchemaLockTarget(statement)).not.toThrow()
    }
    const unparsed = relayPostgresSchemaStatements().filter(
      (statement) =>
        INDEX_OR_ADD_COLUMN.test(sqlWithoutComments(statement)) &&
        schemaLockTarget(statement) === undefined
    )
    expect(unparsed).toEqual([])
  })

  it('reads every derived name as a bare identifier, never a keyword or a qualified name', () => {
    for (const statement of relayPostgresSchemaStatements()) {
      const target = schemaLockTarget(statement)
      if (!target) continue
      expect(target.name).toMatch(/^[a-z_][a-z0-9_]*$/)
      expect(target.table).toMatch(/^[a-z_][a-z0-9_]*$/)
    }
  })

  it('pre-checks every lock-taking statement, with no exceptions', () => {
    // The invariant the rule comment beside SCHEMA depends on: nothing that takes a relation lock
    // reaches the server on a warm boot. A statement with no target breaks it.
    const unchecked = lockTakingStatements().filter(
      (statement) => schemaLockTarget(statement) === undefined
    )
    expect(unchecked).toEqual([])
    expect(lockTakingStatements()).toHaveLength(GOLDEN_LOCK_TAKING.length)
  })

  it('derives a target through the comment block a split schema glues on', () => {
    // Not vacuous: SCHEMA really does carry a comment-prefixed statement, and it is a CREATE INDEX
    // on relay_connection_bases. Classifying the raw text would give it no target at all.
    const commented = relayPostgresSchemaStatements().filter((statement) =>
      statement.startsWith('--')
    )
    expect(commented.length).toBeGreaterThan(0)
    for (const statement of commented) {
      if (!takesRelationLock(statement)) continue
      expect(schemaLockTarget(statement)).toBeDefined()
    }
    expect(commented.map(schemaLockTarget)).toContainEqual({
      kind: 'index',
      table: 'relay_connection_bases',
      name: 'relay_connection_bases_active_deadline',
      skipWhen: 'present'
    })
  })

  it('leaves the dollar-quoted statement-stats migration byte-identical', () => {
    // Its body is a PL/pgSQL block full of commas and parentheses. Reading the tag as anything but
    // opaque would change the text classification sees, and it is the only such statement relay has.
    const doBlock = relayPostgresSchemaStatements().find((statement) => statement.startsWith('DO '))
    expect(doBlock).toBeDefined()
    expect(sqlWithoutComments(doBlock!)).toBe(doBlock)
    expect(takesRelationLock(doBlock!)).toBe(false)
  })

  it('leaves every statement classifiable once its leading comments are stripped', () => {
    for (const statement of relayPostgresSchemaStatements()) {
      expect(sqlWithoutComments(statement)).toMatch(/^(?:CREATE|ALTER|DO)\s/i)
    }
  })
})
