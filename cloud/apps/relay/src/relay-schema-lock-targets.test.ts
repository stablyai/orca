import { describe, expect, it } from 'vitest'
import {
  requireSchemaLockTarget,
  schemaDeferrable,
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
  { kind: 'index', table: 'relay_invites', name: 'relay_invites_sweep_expiry', skipWhen: 'present' },
  {
    kind: 'index',
    table: 'relay_invites',
    name: 'relay_invites_sweep_reservation',
    skipWhen: 'present'
  },
  { kind: 'index', table: 'relay_devices', name: 'relay_devices_current_hash', skipWhen: 'present' },
  { kind: 'index', table: 'relay_devices', name: 'relay_devices_grace_hash', skipWhen: 'present' },
  { kind: 'index', table: 'relay_connection_bases', name: 'relay_connection_bases_active_deadline', skipWhen: 'present' },
  {
    kind: 'index',
    table: 'relay_direct_authorizations',
    name: 'relay_direct_authorizations_pending_deadline',
    skipWhen: 'present'
  },
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
  { kind: 'index', table: 'relay_rate_windows', name: 'relay_rate_windows_started', skipWhen: 'present' },
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
  { kind: 'column', table: 'relay_region_rehome_attempts', name: 'source_generation', skipWhen: 'present' },
  { kind: 'index-by-name', name: 'relay_assignment_activity_expiry', skipWhen: 'absent' },
  {
    kind: 'reloption',
    table: 'relay_assignment_activity_leases',
    name: 'fillfactor=70',
    skipWhen: 'present'
  }
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
      // A reloption is the one target whose name is a pair rather than an identifier, because
      // pg_class stores reloptions as `name=value` text and the value is half the question.
      const shape = target.kind === 'reloption' ? /^[a-z_][a-z0-9_]*=[A-Za-z0-9_.]+$/ : /^[a-z_][a-z0-9_]*$/
      expect(target.name).toMatch(shape)
      // A DROP INDEX names no table, so there is none to check.
      if (target.kind !== 'index-by-name') expect(target.table).toMatch(/^[a-z_][a-z0-9_]*$/)
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
      expect(sqlWithoutComments(statement)).toMatch(/^(?:CREATE|ALTER|DROP|DO)\s/i)
    }
  })

  it('pre-checks the activity-expiry drop by name, and skips it once the index is gone', () => {
    // A DROP INDEX takes ACCESS EXCLUSIVE on the index's table for as long as the index is there,
    // so it is in the census like any other lock-taking statement. Its target resolves by name
    // alone, because the statement names no table and needs none.
    const drops = relayPostgresSchemaStatements().filter((statement) =>
      /^DROP\s/i.test(sqlWithoutComments(statement))
    )
    expect(drops.map(sqlWithoutComments)).toEqual([
      'DROP INDEX IF EXISTS relay_assignment_activity_expiry'
    ])
    for (const statement of drops) {
      expect(takesRelationLock(statement)).toBe(true)
      expect(schemaLockTarget(statement)).toEqual({
        kind: 'index-by-name',
        name: 'relay_assignment_activity_expiry',
        skipWhen: 'absent'
      })
    }
  })

  it('marks the out-of-band sweep indexes and the activity-lease migrations deferrable, and nothing else', () => {
    // The statements a lock timeout must not turn into a crash loop, and the only ones: every
    // other statement still fails the boot loudly, which is what keeps the marker meaningful.
    const deferrable = relayPostgresSchemaStatements().filter(schemaDeferrable)
    expect(deferrable.map((statement) => sqlWithoutComments(statement).replace(/\s+/g, ' '))).toEqual([
      "CREATE INDEX IF NOT EXISTS relay_invites_sweep_expiry ON relay_invites(expires_at) WHERE state IN ('available', 'reserved', 'cooldown')",
      "CREATE INDEX IF NOT EXISTS relay_invites_sweep_reservation ON relay_invites(reservation_expires_at) WHERE state = 'reserved'",
      'CREATE INDEX IF NOT EXISTS relay_direct_authorizations_pending_deadline ON relay_direct_authorizations(deadline) WHERE consumed_at IS NULL',
      'CREATE INDEX IF NOT EXISTS relay_rate_windows_started ON relay_rate_windows(window_started_at)',
      'DROP INDEX IF EXISTS relay_assignment_activity_expiry',
      'ALTER TABLE relay_assignment_activity_leases SET (fillfactor = 70)'
    ])
  })

  it('derives a target for a partial index, WHERE clause and all', () => {
    // The pre-check reads the index name and table from the head of the statement, so a trailing
    // WHERE is invisible to it. Asserted because the sweep indexes depend on that: a parser that
    // gave a partial index no target would send it unchecked on every boot.
    const partial = relayPostgresSchemaStatements().filter((statement) =>
      /^CREATE\s+INDEX\b[\s\S]*\bWHERE\b/i.test(sqlWithoutComments(statement))
    )
    expect(partial.map(schemaLockTarget)).toEqual([
      { kind: 'index', table: 'relay_invites', name: 'relay_invites_sweep_expiry', skipWhen: 'present' },
      {
        kind: 'index',
        table: 'relay_invites',
        name: 'relay_invites_sweep_reservation',
        skipWhen: 'present'
      },
      {
        kind: 'index',
        table: 'relay_direct_authorizations',
        name: 'relay_direct_authorizations_pending_deadline',
        skipWhen: 'present'
      }
    ])
  })

  it('no longer creates an index on the column every control renewal writes', () => {
    // The regression this drop exists to prevent: re-adding it would make ~471 renewals/s non-HOT
    // again. A CREATE anywhere in the schema naming that index fails here.
    const creates = relayPostgresSchemaStatements().filter((statement) =>
      /relay_assignment_activity_expiry/i.test(sqlWithoutComments(statement))
    )
    expect(creates.map(sqlWithoutComments)).toEqual([
      'DROP INDEX IF EXISTS relay_assignment_activity_expiry'
    ])
  })
})
