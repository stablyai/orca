import pg from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  openRelayDatabase,
  REGIONAL_REHOME_DEFAULT_HOST_COOLDOWN_MS,
  type RelayDatabase
} from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const schema = 'relay_rehome_constraint_migration_test'

// The shape shipped before rehoming became bidirectional: a single-region
// column check that Postgres auto-names.
const LEGACY_ATTEMPTS_TABLE = `
CREATE TABLE relay_region_rehome_attempts (
  attempt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  preferred_region TEXT NOT NULL CHECK (preferred_region = 'asia-east2'),
  source_cell_id TEXT NOT NULL,
  source_cell_incarnation TEXT NOT NULL,
  target_cell_id TEXT NOT NULL,
  target_cell_incarnation TEXT NOT NULL,
  previous_epoch BIGINT NOT NULL,
  assignment_epoch BIGINT NOT NULL,
  drain_grace_ms BIGINT NOT NULL,
  send_attempts BIGINT NOT NULL,
  last_send_attempt_at BIGINT,
  drain_receipt_at BIGINT,
  drain_outcome TEXT CHECK (
    drain_outcome IN ('accepted', 'already-accepted', 'host-not-connected')
  ),
  completed_at BIGINT,
  aborted_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (user_id, relay_host_id, assignment_epoch)
)`

// The control row as it shipped before the per-host cooldown existed.
const LEGACY_CONTROL_TABLE = `
CREATE TABLE relay_region_rehome_control (
  control_id TEXT PRIMARY KEY,
  generation BIGINT NOT NULL,
  enabled BIGINT NOT NULL,
  observation_started_at BIGINT NOT NULL,
  not_before BIGINT NOT NULL,
  rate_per_minute BIGINT NOT NULL,
  preference_max_age_ms BIGINT NOT NULL,
  drain_grace_ms BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
)`

const attemptValues = (attemptId: string, preferredRegion: string): unknown[] => [
  attemptId,
  'user-1',
  'abcdefghijklmnop',
  preferredRegion,
  'cell-source',
  '11111111-1111-4111-8111-111111111111',
  'cell-target',
  '22222222-2222-4222-8222-222222222222',
  1,
  Number(attemptId.at(-1)),
  0,
  0,
  1_000_000,
  1_000_000
]

const INSERT_ATTEMPT = `INSERT INTO relay_region_rehome_attempts
  (attempt_id, user_id, relay_host_id, preferred_region, source_cell_id,
   source_cell_incarnation, target_cell_id, target_cell_incarnation,
   previous_epoch, assignment_epoch, drain_grace_ms, send_attempts,
   created_at, updated_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`

describePostgres('PostgreSQL regional rehome constraint migration', () => {
  let scopedUrl = ''

  async function withClient(
    operation: (client: pg.Client) => Promise<void>
  ): Promise<void> {
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await operation(client)
    } finally {
      await client.end()
    }
  }

  beforeEach(async () => {
    await withClient(async (client) => {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await client.query(`CREATE SCHEMA ${schema}`)
      await client.query(`SET search_path = ${schema}`)
      await client.query(LEGACY_ATTEMPTS_TABLE)
      await client.query(LEGACY_CONTROL_TABLE)
      await client.query(
        `INSERT INTO relay_region_rehome_control
         (control_id, generation, enabled, observation_started_at, not_before,
          rate_per_minute, preference_max_age_ms, drain_grace_ms, updated_at)
         VALUES ('global', 3, 0, 1, 0, 10, 86400000, 60000, 1)`
      )
      // Production data the replacement constraint has to validate.
      await client.query(INSERT_ATTEMPT, attemptValues('attempt-1', 'asia-east2'))
    })
    const url = new URL(databaseUrl!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    scopedUrl = url.toString()
  })

  afterAll(async () => {
    await withClient(async (client) => {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    })
  })

  it('upgrades a legacy single-region constraint in place', async () => {
    const database = await openRelayDatabase({ databaseUrl: scopedUrl, dataDir: '' })
    try {
      await withClient(async (client) => {
        await client.query(`SET search_path = ${schema}`)
        await client.query(INSERT_ATTEMPT, attemptValues('attempt-2', 'us-central1'))
        await expect(
          client.query(INSERT_ATTEMPT, attemptValues('attempt-3', 'europe-west1'))
        ).rejects.toMatchObject({ code: '23514' })
        const constraints = await client.query(
          `SELECT conname FROM pg_constraint
           WHERE conrelid = 'relay_region_rehome_attempts'::regclass
             AND conname LIKE '%preferred_region%'
           ORDER BY conname`
        )
        expect(constraints.rows).toEqual([
          { conname: 'relay_region_rehome_attempts_preferred_region_valid' }
        ])
        // The existing control row keeps its tuning and gains the cooldown.
        const control = await client.query(
          `SELECT generation, preference_max_age_ms, host_cooldown_ms
           FROM relay_region_rehome_control WHERE control_id = 'global'`
        )
        expect(control.rows).toEqual([
          {
            generation: '3',
            preference_max_age_ms: '86400000',
            host_cooldown_ms: String(REGIONAL_REHOME_DEFAULT_HOST_COOLDOWN_MS)
          }
        ])
      })
    } finally {
      await database.close()
    }
  })

  it('upgrades once across concurrent startups', async () => {
    const results = await Promise.allSettled(
      Array.from(
        { length: 5 },
        async (): Promise<RelayDatabase> =>
          await openRelayDatabase({ databaseUrl: scopedUrl, dataDir: '' })
      )
    )
    const databases = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    await Promise.all(databases.map(async (database) => await database.close()))

    expect(
      results.flatMap((result) =>
        result.status === 'rejected'
          ? [
              {
                code: (result.reason as { code?: unknown }).code,
                message: String(result.reason)
              }
            ]
          : []
      )
    ).toEqual([])
    await withClient(async (client) => {
      await client.query(`SET search_path = ${schema}`)
      await client.query(INSERT_ATTEMPT, attemptValues('attempt-4', 'us-central1'))
      const constraints = await client.query(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'relay_region_rehome_attempts'::regclass
           AND conname LIKE '%preferred_region%'`
      )
      expect(constraints.rows).toEqual([
        { conname: 'relay_region_rehome_attempts_preferred_region_valid' }
      ])
    })
  }, 60_000)
})
