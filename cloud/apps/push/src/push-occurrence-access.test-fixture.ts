import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import pg from 'pg'
import { expect, vi } from 'vitest'
import { durablePushTestDatabaseUrl } from './durable-push-store.test-fixture.js'
import {
  authorityFixture,
  required,
  type AuthorityWork
} from './push-occurrence-authority.test-fixture.js'
import { ownerCleanup, record } from './push-owner-integration.test-fixture.js'
import type { SqlRow } from './push-database.js'

function binding(value: unknown): SQLInputValue {
  if (value == null) {
    return null
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value
  }
  throw new Error('Unexpected captured SQL binding')
}
function nodes(value: unknown): SqlRow[] {
  const node = record(value)
  return [node, ...(Array.isArray(node.Plans) ? node.Plans.flatMap(nodes) : [])]
}

// Native diagnostics own their connection/rollback; the application still uses its real database.
export async function accessFixture(options: Parameters<typeof authorityFixture>[0] = {}) {
  let sqlite: DatabaseSync | undefined
  const prepare = DatabaseSync.prototype.prepare
  const capture = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql
  ) {
    sqlite = this
    return prepare.call(this, sql)
  })
  let client: pg.Client | undefined
  let f: Awaited<ReturnType<typeof authorityFixture>> | undefined
  try {
    try {
      f = await authorityFixture(options)
    } finally {
      capture.mockRestore()
    }
    const owner = f
    if (owner.database.dialect === 'postgres') {
      const [schema] = await owner.database.query('SELECT current_schema() AS name')
      const name = String(required(schema).name)
      if (!/^durable_[a-f0-9]+$/.test(name)) {
        throw new Error('Unowned diagnostic schema')
      }
      const url = new URL(required(durablePushTestDatabaseUrl))
      url.searchParams.set('options', `-c search_path=${name}`)
      client = new pg.Client({ connectionString: url.toString() })
      await client.connect()
    }
    const diagnostic = client
    return {
      f: owner,
      explain: async (
        work: AuthorityWork,
        mutation?: 'push_batch_admissions' | 'push_occurrence_domains'
      ) => {
        expect(work.outcome).toBe('returned')
        if (!diagnostic) {
          const rows = required(sqlite)
            .prepare(`EXPLAIN QUERY PLAN ${work.sql}`)
            .all(...work.params.map(binding))
          return {
            text: JSON.stringify(rows),
            visits: undefined,
            buffers: undefined,
            changed: undefined,
            rows
          }
        }
        let index = 0
        const sql = work.sql.replace(/\?/g, () => `$${++index}`)
        const size = async () => {
          const result = await diagnostic.query<SqlRow>(`SELECT COUNT(*) AS n FROM ${mutation}`)
          return Number(required(result.rows[0]).n)
        }
        await diagnostic.query('BEGIN')
        let resultPlan:
          | {
              text: string
              visits: number
              buffers: number
              changed: number | undefined
              rows: unknown[]
            }
          | undefined
        let primary: { failed: true; error: unknown } | undefined
        try {
          const before = mutation ? await size() : 0
          const result = await diagnostic.query<SqlRow>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
            work.params
          )
          const plans = required(result.rows[0])['QUERY PLAN']
          if (!Array.isArray(plans)) {
            throw new Error('Missing analyzed PostgreSQL plan')
          }
          const root = record(record(plans[0]).Plan)
          const scans = nodes(root).filter(
            (node) => node['Relation Name'] && node['Node Type'] !== 'ModifyTable'
          )
          const visits = scans.reduce(
            (sum, node) =>
              sum +
              Number(node['Actual Loops']) *
                (Number(node['Actual Rows']) +
                  Number(node['Rows Removed by Filter'] ?? 0) +
                  Number(node['Rows Removed by Index Recheck'] ?? 0)),
            0
          )
          const buffers =
            Number(root['Shared Hit Blocks'] ?? 0) + Number(root['Shared Read Blocks'] ?? 0)
          expect(Number.isFinite(visits) && Number.isFinite(buffers)).toBe(true)
          resultPlan = {
            text: JSON.stringify(plans),
            visits,
            buffers,
            changed: mutation ? before - (await size()) : undefined,
            rows: plans
          }
        } catch (error) {
          primary = { failed: true, error }
        }
        const cleanup = ownerCleanup(primary)
        await cleanup.run(() => diagnostic.query('ROLLBACK'))
        cleanup.finish()
        return required(resultPlan)
      },
      close: async () => {
        const cleanup = ownerCleanup()
        await cleanup.run(() => owner.close())
        await cleanup.run(() => diagnostic?.end())
        cleanup.finish()
      }
    }
  } catch (error) {
    capture.mockRestore()
    const cleanup = ownerCleanup({ failed: true, error })
    await cleanup.run(() => f?.close())
    await cleanup.run(() => client?.end())
    cleanup.finish()
    throw error
  }
}

export async function irrelevantCorpus(
  f: Awaited<ReturnType<typeof authorityFixture>>,
  axis: 'history' | 'queue' | 'domains',
  count: number
) {
  const sequence = 'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)'
  if (axis === 'history') {
    await f.database.query(
      `INSERT INTO push_batch_admissions
      ${sequence} SELECT 'irrelevant-' || n, 'destination', 'key', 'attempt', ? FROM seq`,
      [count, f.clock() + 300_000]
    )
  } else if (axis === 'queue') {
    await f.database.query(
      `INSERT INTO push_delivery_batches
      (batch_id, host_fingerprint, registration_id, kind, payload_json, state,
      due_at, expires_at, lease_until, attempts, created_at)
      ${sequence} SELECT 'irrelevant-' || n, 'other-host', 'other-phone', 'alert', ?, 'pending',
      ?, ?, 0, 0, ? FROM seq`,
      [count, JSON.stringify(f.alert()), f.clock() + 300_000, f.clock() + 300_000, f.clock()]
    )
  } else {
    await f.database.query(
      `INSERT INTO push_occurrence_domains
      (destination, route_key, origin, occurrence, state, lease_until, created_at)
      ${sequence} SELECT 'irrelevant-' || n, 'key', 'origin', 'occurrence', 'sent', 0, ? FROM seq`,
      [count, f.clock()]
    )
  }
  await f.database.query('ANALYZE')
}

export async function clearCorpus(f: Awaited<ReturnType<typeof authorityFixture>>) {
  await f.database.query("DELETE FROM push_batch_admissions WHERE batch_id LIKE 'irrelevant-%'")
  await f.database.query("DELETE FROM push_delivery_batches WHERE batch_id LIKE 'irrelevant-%'")
  await f.database.query(
    "DELETE FROM push_occurrence_domains WHERE destination LIKE 'irrelevant-%'"
  )
}

export function assertAccess(
  plan: Awaited<ReturnType<Awaited<ReturnType<typeof accessFixture>>['explain']>>,
  indexes: string[],
  dialect: 'sqlite' | 'postgres',
  label: string
) {
  for (const name of indexes) {
    expect(plan.text).toContain(name)
  }
  if (dialect === 'postgres') {
    // Analyzed scan outputs + filtered/rechecked tuples, not invisible executor/lock visits.
    expect(plan.visits).toBeLessThanOrEqual(128)
    expect(plan.buffers).toBeLessThanOrEqual(512)
  } else {
    expect(plan.text).toContain('SEARCH') // Access path only; no SQLite VM-step/row-lock claim.
  }
  console.info(
    JSON.stringify({
      authorityAccess: label,
      dialect,
      diagnosticChanged: plan.changed,
      analyzedScanTuples: plan.visits,
      sharedBuffers: plan.buffers,
      plan: plan.rows
    })
  )
}
