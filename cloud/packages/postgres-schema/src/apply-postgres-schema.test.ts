import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyPostgresSchema } from './apply-postgres-schema.js'
import type { SchemaCatalogRow } from './catalog-object-precheck.js'

function postgresError(code: string, constraint?: string): Error {
  return Object.assign(new Error(code), constraint === undefined ? { code } : { code, constraint })
}

const COMMENTED_INDEX = `-- Why the sweep needs this index
CREATE INDEX IF NOT EXISTS relay_bases_active ON relay_connection_bases(active, deadline)`

const COMMENTED_TABLE = `-- Two comment lines, the other shape a split schema carries
-- above a statement
CREATE TABLE IF NOT EXISTS relay_cells (
  cell_id TEXT PRIMARY KEY
)`

// Answers absent first and present afterwards, the state a concurrent create leaves behind.
function catalogAnswersInSequence(answers: SchemaCatalogRow[][]): {
  catalogQuery: (sql: string, params: unknown[]) => Promise<SchemaCatalogRow[]>
  asked: unknown[][]
} {
  const asked: unknown[][] = []
  return {
    asked,
    catalogQuery: async (sql, params) => {
      asked.push([sql, ...params])
      return answers[asked.length - 1] ?? []
    }
  }
}

function catalogAnswers(rows: SchemaCatalogRow[]): {
  catalogQuery: (sql: string, params: unknown[]) => Promise<SchemaCatalogRow[]>
  asked: unknown[][]
} {
  const asked: unknown[][] = []
  return {
    asked,
    catalogQuery: async (sql, params) => {
      asked.push([sql, ...params])
      return rows
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('applyPostgresSchema classification', () => {
  it('classifies a comment-prefixed CREATE INDEX by its first SQL keyword', async () => {
    let calls = 0
    const query = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw postgresError('42P07')
      return undefined
    })
    await applyPostgresSchema([COMMENTED_INDEX], query, { wait: async () => undefined })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('classifies a comment-prefixed CREATE TABLE by its own collision codes', async () => {
    // pg_type_typname_nsp_index is reached only through the CREATE TABLE branch, so a statement
    // misread as unknown would fail the boot on a benign concurrent create instead of retrying.
    let calls = 0
    const query = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw postgresError('23505', 'pg_type_typname_nsp_index')
      return undefined
    })
    await applyPostgresSchema([COMMENTED_TABLE], query, { wait: async () => undefined })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('retries a concurrent index collision until it succeeds', async () => {
    let calls = 0
    const query = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw postgresError('23505', 'pg_class_relname_nsp_index')
      return undefined
    })
    const summary = await applyPostgresSchema(['CREATE INDEX IF NOT EXISTS i ON t(c)'], query, {
      wait: async () => undefined
    })
    expect(query).toHaveBeenCalledTimes(3)
    expect(summary).toEqual({ ran: 1, skipped: 0 })
  })

  it('treats an already-applied constraint as skipped rather than an error', async () => {
    // Still the answer for a caller with no pre-check, and for a constraint another director
    // committed between this boot's pre-check and its ALTER TABLE.
    const query = vi.fn(async () => {
      throw postgresError('42710')
    })
    const summary = await applyPostgresSchema(['ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0)'], query)
    expect(summary).toEqual({ ran: 0, skipped: 1 })
  })

  it('propagates an unrelated error without retrying', async () => {
    const query = vi.fn(async () => {
      throw postgresError('42501')
    })
    await expect(
      applyPostgresSchema(['CREATE TABLE IF NOT EXISTS t (id TEXT)'], query)
    ).rejects.toThrow(/42501/)
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('applyPostgresSchema lock timeouts', () => {
  it('does not retry a lock timeout', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const query = vi.fn(async () => {
      throw postgresError('55P03')
    })
    await expect(
      applyPostgresSchema(['CREATE INDEX IF NOT EXISTS i ON t(c)'], query, {
        wait: async () => undefined
      })
    ).rejects.toThrow(/55P03/)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('names the statement that could not take its lock', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: string) => {
      lines.push(line)
    })
    const query = vi.fn(async () => {
      throw postgresError('55P03')
    })
    await expect(applyPostgresSchema([COMMENTED_INDEX], query)).rejects.toThrow(/55P03/)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      event: 'orca_relay_postgres_schema_lock_timeout',
      code: '55P03',
      statement: 'CREATE INDEX IF NOT EXISTS relay_bases_active ON relay_connection_bases(active, deadline)'
    })
  })

  it('still retries a lock timeout for a caller that opts in', async () => {
    // A caller with no catalog pre-check learns nothing from a lock timeout about whether the
    // object exists, so its old bounded retry is the correct behaviour there.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let calls = 0
    const query = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw postgresError('55P03')
      return undefined
    })
    await applyPostgresSchema(['CREATE INDEX IF NOT EXISTS i ON t(c)'], query, {
      retryLockTimeout: true,
      wait: async () => undefined
    })
    expect(query).toHaveBeenCalledTimes(3)
  })
})

describe('applyPostgresSchema catalog pre-check', () => {
  it('sends no lock-taking statement when the catalog has the object', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const query = vi.fn(async (_statement: string) => undefined)
    const { catalogQuery, asked } = catalogAnswers([{ indisvalid: true }])
    const summary = await applyPostgresSchema([COMMENTED_TABLE, COMMENTED_INDEX], query, {
      catalogQuery
    })
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([COMMENTED_TABLE])
    expect(asked).toEqual([
      [expect.stringContaining('pg_catalog.pg_index'), 'relay_connection_bases', 'relay_bases_active']
    ])
    expect(summary).toEqual({ ran: 1, skipped: 1 })
  })

  it('skips an index the catalog reports as invalid rather than rebuilding it', async () => {
    // A cancelled CREATE INDEX CONCURRENTLY leaves exactly this state, and IF NOT EXISTS skips it
    // too, so reading indisvalid as a condition would newly take the lock it used to avoid.
    const logged: { event?: string }[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(JSON.parse(line))
    })
    const query = vi.fn(async (_statement: string) => undefined)
    const { catalogQuery } = catalogAnswers([{ indisvalid: false }])
    await applyPostgresSchema([COMMENTED_INDEX], query, { catalogQuery })
    expect(query).not.toHaveBeenCalled()
    expect(logged.filter((entry) => entry.event?.endsWith('_object_present'))).toEqual([
      {
        event: 'orca_relay_postgres_schema_object_present',
        kind: 'index',
        table: 'relay_connection_bases',
        name: 'relay_bases_active',
        indisvalid: false
      }
    ])
  })

  it('reports how many statements ran and how many were skipped', async () => {
    const logged: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line)
    })
    const { catalogQuery } = catalogAnswers([{ indisvalid: true }])
    await applyPostgresSchema([COMMENTED_TABLE, COMMENTED_INDEX], vi.fn(async () => undefined), {
      catalogQuery,
      eventPrefix: 'orca_push_postgres_schema'
    })
    expect(JSON.parse(logged[logged.length - 1] ?? '{}')).toEqual({
      event: 'orca_push_postgres_schema_applied',
      ran: 1,
      skipped: 1
    })
  })

  it('asks pg_attribute for a column and sends the ALTER TABLE when no row comes back', async () => {
    const query = vi.fn(async (_statement: string) => undefined)
    const { catalogQuery, asked } = catalogAnswers([])
    const statement = 'ALTER TABLE relay_control_capabilities ADD COLUMN IF NOT EXISTS idle BIGINT'
    const summary = await applyPostgresSchema([statement], query, { catalogQuery })
    expect(asked).toEqual([
      [expect.stringContaining('pg_catalog.pg_attribute'), 'relay_control_capabilities', 'idle']
    ])
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([statement])
    expect(summary).toEqual({ ran: 1, skipped: 0 })
  })

  it('never probes the catalog for a statement that takes no relation lock', async () => {
    const query = vi.fn(async (_statement: string) => undefined)
    const { catalogQuery, asked } = catalogAnswers([{ indisvalid: true }])
    await applyPostgresSchema([COMMENTED_TABLE], query, { catalogQuery })
    expect(asked).toEqual([])
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('skips an ADD CONSTRAINT the catalog already names', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const query = vi.fn(async (_statement: string) => undefined)
    const { catalogQuery, asked } = catalogAnswers([{}])
    const summary = await applyPostgresSchema(
      ['ALTER TABLE relay_region_rehome_attempts ADD CONSTRAINT region_valid CHECK (r IN (1))'],
      query,
      { catalogQuery }
    )
    expect(asked).toEqual([
      [
        expect.stringContaining('pg_catalog.pg_constraint'),
        'relay_region_rehome_attempts',
        'region_valid'
      ]
    ])
    expect(query).not.toHaveBeenCalled()
    expect(summary).toEqual({ ran: 0, skipped: 1 })
  })

  it('skips a DROP CONSTRAINT IF EXISTS when the constraint is already gone', async () => {
    // Inverse polarity: an absent constraint is what means there is nothing to drop. Sending it
    // anyway takes ACCESS EXCLUSIVE to discover the same thing.
    const logged: { event?: string }[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(JSON.parse(line))
    })
    const query = vi.fn(async (_statement: string) => undefined)
    const { catalogQuery } = catalogAnswers([])
    const summary = await applyPostgresSchema(
      ['ALTER TABLE relay_region_rehome_attempts DROP CONSTRAINT IF EXISTS region_check'],
      query,
      { catalogQuery }
    )
    expect(query).not.toHaveBeenCalled()
    expect(summary).toEqual({ ran: 0, skipped: 1 })
    expect(logged).toContainEqual({
      event: 'orca_relay_postgres_schema_object_absent',
      kind: 'constraint',
      table: 'relay_region_rehome_attempts',
      name: 'region_check',
      indisvalid: undefined
    })
  })

  it('sends a DROP CONSTRAINT IF EXISTS when the constraint is still there', async () => {
    const query = vi.fn(async (_statement: string) => undefined)
    const { catalogQuery } = catalogAnswers([{}])
    const statement = 'ALTER TABLE t DROP CONSTRAINT IF EXISTS region_check'
    const summary = await applyPostgresSchema([statement], query, { catalogQuery })
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([statement])
    expect(summary).toEqual({ ran: 1, skipped: 0 })
  })

  it('sends an ADD CONSTRAINT the catalog does not name yet', async () => {
    const query = vi.fn(async (_statement: string) => undefined)
    const { catalogQuery } = catalogAnswers([])
    const statement = 'ALTER TABLE t ADD CONSTRAINT region_valid CHECK (r IN (1))'
    const summary = await applyPostgresSchema([statement], query, { catalogQuery })
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([statement])
    expect(summary).toEqual({ ran: 1, skipped: 0 })
  })

  it('sends every statement when no catalog query is supplied', async () => {
    const query = vi.fn(async (_statement: string) => undefined)
    const summary = await applyPostgresSchema([COMMENTED_TABLE, COMMENTED_INDEX], query)
    expect(query).toHaveBeenCalledTimes(2)
    expect(summary).toEqual({ ran: 2, skipped: 0 })
  })
})

describe('applyPostgresSchema concurrent creates', () => {
  it('re-asks the catalog on a collision instead of retrying the CREATE INDEX', async () => {
    // Another director created the index between the pre-check and this statement. Retrying would
    // take SHARE on the table again for an object that is already there.
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const query = vi.fn(async (_statement: string) => {
      throw postgresError('42P07')
    })
    const { catalogQuery, asked } = catalogAnswersInSequence([[], [{ indisvalid: true }]])
    const summary = await applyPostgresSchema([COMMENTED_INDEX], query, {
      catalogQuery,
      wait: async () => undefined
    })
    expect(query).toHaveBeenCalledTimes(1)
    expect(asked).toHaveLength(2)
    expect(summary).toEqual({ ran: 0, skipped: 1 })
  })

  it('still retries when the catalog says the object is not there after all', async () => {
    let calls = 0
    const query = vi.fn(async (_statement: string) => {
      calls += 1
      if (calls === 1) throw postgresError('23505', 'pg_class_relname_nsp_index')
      return undefined
    })
    const { catalogQuery } = catalogAnswersInSequence([[], []])
    const summary = await applyPostgresSchema([COMMENTED_INDEX], query, {
      catalogQuery,
      wait: async () => undefined
    })
    expect(query).toHaveBeenCalledTimes(2)
    expect(summary).toEqual({ ran: 1, skipped: 0 })
  })

  it('retries a CREATE TABLE collision without a catalog re-ask, having no target to ask about', async () => {
    let calls = 0
    const query = vi.fn(async (_statement: string) => {
      calls += 1
      if (calls === 1) throw postgresError('42710')
      return undefined
    })
    const { catalogQuery, asked } = catalogAnswersInSequence([[], []])
    await applyPostgresSchema([COMMENTED_TABLE], query, {
      catalogQuery,
      wait: async () => undefined
    })
    expect(asked).toEqual([])
    expect(query).toHaveBeenCalledTimes(2)
  })
})

describe('applyPostgresSchema unparseable statements', () => {
  it('fails the boot rather than sending an index whose target cannot be read', async () => {
    const query = vi.fn(async (_statement: string) => undefined)
    await expect(applyPostgresSchema(['CREATE INDEX ON t(c)'], query)).rejects.toThrow(
      /unparsed_schema_lock_target/
    )
    expect(query).not.toHaveBeenCalled()
  })

  it('fails even with no catalog query, because the statement would take the lock either way', async () => {
    const query = vi.fn(async (_statement: string) => undefined)
    await expect(
      applyPostgresSchema(['ALTER TABLE t ADD COLUMN IF NOT EXISTS'], query)
    ).rejects.toThrow(/unparsed_schema_lock_target/)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('applyPostgresSchema statement text', () => {
  it('sends the original statement, comments included, not the classified form', async () => {
    // Classification reads a comment-free copy. Rewriting what the server runs would change the
    // DDL itself, and a comment inside a string literal or a quoted name is part of the statement.
    const statement = `ALTER TABLE t ADD /* note */ COLUMN c TEXT DEFAULT '-- keep'`
    const query = vi.fn(async (_sql: string) => undefined)
    const { catalogQuery, asked } = catalogAnswers([])
    await applyPostgresSchema([statement], query, { catalogQuery })
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([statement])
    expect(asked).toEqual([[expect.stringContaining('pg_catalog.pg_attribute'), 't', 'c']])
  })

  it('sends a comment-prefixed statement unchanged too', async () => {
    const query = vi.fn(async (_sql: string) => undefined)
    await applyPostgresSchema([COMMENTED_TABLE], query)
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([COMMENTED_TABLE])
  })
})
