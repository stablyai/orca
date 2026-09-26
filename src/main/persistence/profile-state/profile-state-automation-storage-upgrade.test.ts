import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { openProfileStateDatabase, profileStatePragmaNumber } from './profile-state-database'
import { PROFILE_STATE_DATABASE_SCHEMA_VERSION } from './profile-state-database-schema'
import { hashProfileStatePayload } from './profile-state-document-validation'
import { exportProfileStateJson, importProfileStateJson } from './profile-state-documents'
import { readProfileStateDomain } from './profile-state-domain-reader'
import { writeProfileStateDomain } from './profile-state-domain-writes'

const directories: string[] = []
const connections: Database.Database[] = []
const staleRuns = [{ id: 'deleted-run', status: 'running', output: 'stale history'.repeat(1_000) }]
const liveRuns = [{ id: 'live-run', status: 'completed', future: { retained: true } }]

afterEach(() => {
  for (const db of connections.splice(0)) {
    db.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-automation-upgrade-'))
  directories.push(directory)
  return join(directory, 'profile-state.db')
}

function openDatabase(path: string): Database.Database {
  const { db } = openProfileStateDatabase(path, 'profile-a')
  connections.push(db)
  return db
}

function expectRejectedDatabaseUntouched(path: string, profileId = 'profile-a'): void {
  const before = readFileSync(path)
  expect(() => {
    const { db } = openProfileStateDatabase(path, profileId)
    connections.push(db)
  }).toThrowError(
    expect.objectContaining({
      code: profileId === 'profile-a' ? 'unreadable' : 'identity-mismatch'
    })
  )
  expect(readFileSync(path)).toEqual(before)
}

type LegacyProjection = {
  presence: 'array' | 'null' | 'absent'
  runs?: readonly { id: string; [key: string]: unknown }[]
}

function seedLegacyDatabase(
  version: 1 | 2,
  root: Record<string, unknown>,
  projection?: LegacyProjection,
  revision = projection ? 2 : 1
): string {
  const path = databasePath()
  const db = new Database(path)
  try {
    db.exec(`
      CREATE TABLE profile_state_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE profile_state_documents (
        domain TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL,
        domain_version INTEGER NOT NULL, revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, content_hash TEXT NOT NULL
      );
    `)
    db.prepare('INSERT INTO profile_state_meta VALUES (?, ?)').run('profile_id', 'profile-a')
    db.prepare('INSERT INTO profile_state_meta VALUES (?, ?)').run('revision', String(revision))
    for (const [domain, value] of Object.entries(root)) {
      const payload = JSON.stringify(value)
      db.prepare('INSERT INTO profile_state_documents VALUES (?, ?, 1, 1, 100, ?)').run(
        domain,
        payload,
        hashProfileStatePayload(payload)
      )
    }
    if (version === 2) {
      db.exec(`
        CREATE TABLE profile_state_automation_runs_meta (
          domain TEXT PRIMARY KEY NOT NULL, presence TEXT NOT NULL,
          domain_version INTEGER NOT NULL, revision INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, content_hash TEXT NOT NULL
        );
        CREATE TABLE profile_state_automation_runs (
          run_id TEXT PRIMARY KEY NOT NULL, ordinal INTEGER NOT NULL,
          payload TEXT NOT NULL, content_hash TEXT NOT NULL,
          revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
      `)
      if (projection) {
        const runs = projection.runs ?? []
        const payload = projection.presence === 'array' ? JSON.stringify(runs) : 'null'
        db.prepare(
          'INSERT INTO profile_state_automation_runs_meta VALUES (?, ?, 1, 2, 200, ?)'
        ).run(
          'automationRuns',
          projection.presence,
          projection.presence === 'absent' ? '' : hashProfileStatePayload(payload)
        )
        for (const [ordinal, run] of runs.entries()) {
          const runPayload = JSON.stringify(run)
          db.prepare('INSERT INTO profile_state_automation_runs VALUES (?, ?, ?, ?, 2, 200)').run(
            run.id,
            ordinal,
            runPayload,
            hashProfileStatePayload(runPayload)
          )
        }
      }
    }
    db.pragma(`user_version = ${version}`)
  } finally {
    db.close()
  }
  return path
}

describe('automation storage schema upgrades', () => {
  it.each([
    { label: 'supported runs', value: liveRuns },
    { label: 'explicit null', value: null },
    { label: 'unknown object', value: { futureFormat: [1, 2] } },
    { label: 'duplicate identifiers', value: [{ id: 'same' }, { id: 'same', future: true }] }
  ])('preserves version 1 $label and domain ordering', ({ value }) => {
    const root = { settings: { theme: 'dark' }, automationRuns: value, futureDomain: [2, 1] }
    const db = openDatabase(seedLegacyDatabase(1, root))

    expect(profileStatePragmaNumber(db, 'user_version')).toBe(PROFILE_STATE_DATABASE_SCHEMA_VERSION)
    expect(exportProfileStateJson(db)).toBe(JSON.stringify(root))
    expect(db.prepare('SELECT presence FROM profile_state_automation_runs_meta').get()).toEqual({
      presence: 'document'
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM profile_state_automation_runs').get()).toEqual(
      {
        count: 0
      }
    )
  })

  it('normalizes a version 1 document on replacement without duplicating its payload', () => {
    const root = { settings: {}, automationRuns: liveRuns, futureDomain: [2, 1] }
    const db = openDatabase(seedLegacyDatabase(1, root))

    expect(
      writeProfileStateDomain(db, {
        domain: 'automationRuns',
        payload: JSON.stringify(liveRuns),
        expectedRevision: 1
      })
    ).toEqual({ changed: true, revision: 2 })

    expect(exportProfileStateJson(db)).toBe(JSON.stringify(root))
    expect(
      db
        .prepare('SELECT payload FROM profile_state_documents WHERE domain = ?')
        .get('automationRuns')
    ).toEqual({ payload: 'null' })
  })

  it.each([
    { presence: 'array', runs: liveRuns, expected: liveRuns },
    { presence: 'array', runs: [], expected: [] },
    { presence: 'null', expected: null },
    { presence: 'absent', expected: undefined }
  ] as const)(
    'keeps version 2 $presence authority while removing stale retained history',
    (value) => {
      const root = { settings: {}, automationRuns: staleRuns, futureDomain: { kept: true } }
      const path = seedLegacyDatabase(2, root, value)
      const db = openDatabase(path)
      const expected = { ...root, automationRuns: value.expected }

      expect(exportProfileStateJson(db)).toBe(JSON.stringify(expected))
      expect(readProfileStateDomain(path, 'profile-a', 'automationRuns')).toEqual(
        value.expected === undefined
          ? { kind: 'missing' }
          : { kind: 'value', value: value.expected }
      )
      expect(
        db
          .prepare('SELECT payload FROM profile_state_documents WHERE domain = ?')
          .get('automationRuns')
      ).toEqual({ payload: 'null' })
      expect(profileStatePragmaNumber(db, 'user_version')).toBe(
        PROFILE_STATE_DATABASE_SCHEMA_VERSION
      )
    }
  )

  it.each([
    { label: 'stale run array', root: { automationRuns: staleRuns } },
    { label: 'empty array', root: { automationRuns: [] } },
    { label: 'explicit null', root: { automationRuns: null } },
    { label: 'unknown value', root: { automationRuns: { futureFormat: true } } },
    { label: 'absent domain', root: {} }
  ])('refuses ambiguous version 2 $label without rewriting it', ({ root }) => {
    const path = seedLegacyDatabase(2, root)
    expectRejectedDatabaseUntouched(path)
    const db = new Database(path)
    connections.push(db)
    expect(profileStatePragmaNumber(db, 'user_version')).toBe(2)
    expect(db.prepare('SELECT domain FROM profile_state_automation_runs_meta').all()).toEqual([])
    expect(
      db.prepare('SELECT domain, payload FROM profile_state_documents ORDER BY rowid').all()
    ).toEqual(
      Object.entries(root).map(([domain, value]) => ({ domain, payload: JSON.stringify(value) }))
    )
  })

  it('upgrades a genuinely empty version 2 database', () => {
    const db = openDatabase(seedLegacyDatabase(2, {}, undefined, 0))
    expect(exportProfileStateJson(db)).toBe('{}')
    expect(importProfileStateJson(db, JSON.stringify({ automationRuns: liveRuns }))).toBe(1)
    expect(JSON.parse(exportProfileStateJson(db))).toEqual({ automationRuns: liveRuns })
  })

  it.each(['legacy document', 'normalized row', 'projection metadata'])(
    'rolls back version 2 migration with corrupt %s',
    (target) => {
      const path = seedLegacyDatabase(
        2,
        { automationRuns: staleRuns },
        { presence: 'array', runs: liveRuns }
      )
      const tampered = new Database(path)
      try {
        if (target === 'legacy document') {
          tampered.exec("UPDATE profile_state_documents SET content_hash = 'broken'")
        } else if (target === 'normalized row') {
          tampered.exec("UPDATE profile_state_automation_runs SET content_hash = 'broken'")
        } else {
          tampered.exec("UPDATE profile_state_automation_runs_meta SET content_hash = 'broken'")
        }
      } finally {
        tampered.close()
      }

      expectRejectedDatabaseUntouched(path)
      const db = new Database(path)
      connections.push(db)
      expect(profileStatePragmaNumber(db, 'user_version')).toBe(2)
      expect(
        db
          .prepare('SELECT payload FROM profile_state_documents WHERE domain = ?')
          .get('automationRuns')
      ).toEqual({ payload: JSON.stringify(staleRuns) })
    }
  )
})

describe('rejected schema upgrades preserve source bytes', () => {
  it.each([1, 2] as const)('rejects another profile in schema %s before migration', (version) => {
    const path = seedLegacyDatabase(
      version,
      { automationRuns: staleRuns },
      { presence: 'array', runs: liveRuns }
    )
    expectRejectedDatabaseUntouched(path, 'profile-b')
  })

  it.each([1, 2] as const)(
    'rejects an incompatible schema %s document column before migration',
    (version) => {
      const path = seedLegacyDatabase(
        version,
        { automationRuns: staleRuns },
        { presence: 'array', runs: liveRuns }
      )
      const db = new Database(path)
      try {
        db.exec(`
        ALTER TABLE profile_state_documents RENAME TO old_documents;
        CREATE TABLE profile_state_documents (
          domain TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL,
          domain_version INTEGER NOT NULL, revision INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, content_hash TEXT NOT NULL
        );
        INSERT INTO profile_state_documents SELECT * FROM old_documents;
        DROP TABLE old_documents;
      `)
      } finally {
        db.close()
      }
      expectRejectedDatabaseUntouched(path)
    }
  )

  it.each([
    { label: 'negative schema version', sql: 'PRAGMA user_version = -1' },
    { label: 'missing run table', sql: 'DROP TABLE profile_state_automation_runs' },
    { label: 'missing metadata table', sql: 'DROP TABLE profile_state_automation_runs_meta' }
  ])('rejects a version 2 database with $label before migration', ({ sql }) => {
    const path = seedLegacyDatabase(
      2,
      { automationRuns: staleRuns },
      { presence: 'array', runs: liveRuns }
    )
    const db = new Database(path)
    try {
      db.exec(sql)
    } finally {
      db.close()
    }
    expectRejectedDatabaseUntouched(path)
  })
})

describe('required automation storage metadata', () => {
  it.each([
    { label: 'cleared array', payload: '[]' },
    { label: 'explicit null', payload: 'null' },
    { label: 'removed domain', payload: null }
  ])('refuses lost metadata after $label instead of resurrecting retained state', ({ payload }) => {
    const path = databasePath()
    const db = openDatabase(path)
    importProfileStateJson(db, JSON.stringify({ automationRuns: staleRuns }))
    writeProfileStateDomain(db, { domain: 'automationRuns', payload, expectedRevision: 1 })
    db.exec('DELETE FROM profile_state_automation_runs_meta')

    expect(() => exportProfileStateJson(db)).toThrow()
    expect(readProfileStateDomain(path, 'profile-a', 'automationRuns')).toMatchObject({
      kind: 'unreadable'
    })
    expect(() =>
      writeProfileStateDomain(db, {
        domain: 'automationRuns',
        payload: JSON.stringify(liveRuns),
        expectedRevision: 2
      })
    ).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM profile_state_automation_runs').get()).toEqual(
      { count: 0 }
    )
  })

  it.each(['revision = 1', 'updated_at = 1', 'domain_version = 2', "content_hash = 'unexpected'"])(
    'rejects a malformed document marker (%s)',
    (assignment) => {
      const db = openDatabase(databasePath())
      importProfileStateJson(db, JSON.stringify({ automationRuns: { futureFormat: true } }))
      db.exec(`UPDATE profile_state_automation_runs_meta SET ${assignment}`)
      expect(() => exportProfileStateJson(db)).toThrow()
    }
  )

  it('keeps one authority through complete imports of supported, unknown, and absent history', () => {
    const db = openDatabase(databasePath())
    for (const root of [
      { settings: {}, automationRuns: liveRuns },
      { settings: {}, automationRuns: { futureFormat: [2, 1] } },
      { settings: {} },
      { settings: {}, automationRuns: null },
      { settings: {}, automationRuns: [] }
    ]) {
      importProfileStateJson(db, JSON.stringify(root))
      expect(exportProfileStateJson(db)).toBe(JSON.stringify(root))
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM profile_state_automation_runs_meta').get()
      ).toEqual({ count: 1 })
    }
  })

  it('rejects reopening a current database with lost metadata before changing its bytes', () => {
    const path = databasePath()
    const { db } = openProfileStateDatabase(path, 'profile-a')
    db.exec('DELETE FROM profile_state_automation_runs_meta')
    db.close()
    const before = readFileSync(path)

    expect(() => openDatabase(path)).toThrow()
    expect(readFileSync(path)).toEqual(before)
  })
})
