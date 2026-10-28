import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importProfileStateJson } from './profile-state-documents'
import { openProfileStateDatabase, profileStateDatabaseFile } from './profile-state-database'
import {
  readProfileStateDomains,
  readProfileStateDomainsWithRevisionFromDatabase
} from './profile-state-domain-reader'
import { writeProfileStateDomains } from './profile-state-domain-writes'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createDatabase(): { directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-domain-reader-'))
  temporaryDirectories.push(directory)
  return { directory, databasePath: profileStateDatabaseFile(directory) }
}

describe('profile state domain reader', () => {
  it('does not parse unrelated domains', () => {
    const { databasePath } = createDatabase()
    const opened = openProfileStateDatabase(databasePath, 'profile-a')
    importProfileStateJson(
      opened.db,
      JSON.stringify({ settings: { theme: 'dark' }, unrelated: { keep: true } })
    )
    opened.db
      .prepare('UPDATE profile_state_documents SET payload = ? WHERE domain = ?')
      .run('{invalid', 'unrelated')
    opened.db.close()

    const result = readProfileStateDomains(databasePath, 'profile-a', ['settings'])
    expect(result).toEqual({
      kind: 'values',
      revision: 1,
      values: new Map([['settings', { theme: 'dark' }]])
    })
  })

  it('fails closed when a selected domain is corrupt', () => {
    const { databasePath } = createDatabase()
    const opened = openProfileStateDatabase(databasePath, 'profile-a')
    importProfileStateJson(opened.db, JSON.stringify({ settings: { theme: 'dark' } }))
    opened.db
      .prepare('UPDATE profile_state_documents SET payload = ? WHERE domain = ?')
      .run('{invalid', 'settings')
    opened.db.close()

    const result = readProfileStateDomains(databasePath, 'profile-a', ['settings'])
    expect(result.kind).toBe('unreadable')
  })

  it('reads the normalized automation projection when selected', () => {
    const { databasePath } = createDatabase()
    const opened = openProfileStateDatabase(databasePath, 'profile-a')
    importProfileStateJson(
      opened.db,
      JSON.stringify({ automationRuns: [{ id: 'run-1', status: 'pending' }] })
    )
    opened.db.close()

    const result = readProfileStateDomains(databasePath, 'profile-a', ['automationRuns'])
    expect(result).toEqual({
      kind: 'values',
      revision: 1,
      values: new Map([['automationRuns', [{ id: 'run-1', status: 'pending' }]]])
    })
  })

  it('preserves missing versus explicit null automation runs', () => {
    const missing = createDatabase()
    const missingOpened = openProfileStateDatabase(missing.databasePath, 'profile-a')
    importProfileStateJson(missingOpened.db, JSON.stringify({ settings: { theme: 'dark' } }))
    missingOpened.db.close()
    const missingResult = readProfileStateDomains(missing.databasePath, 'profile-a', [
      'automationRuns'
    ])
    expect(missingResult.kind).toBe('values')
    expect(
      missingResult.kind === 'values' ? missingResult.values.has('automationRuns') : true
    ).toBe(false)

    const explicitNull = createDatabase()
    const nullOpened = openProfileStateDatabase(explicitNull.databasePath, 'profile-a')
    importProfileStateJson(
      nullOpened.db,
      JSON.stringify({ settings: { theme: 'dark' }, automationRuns: null })
    )
    nullOpened.db.close()
    const nullResult = readProfileStateDomains(explicitNull.databasePath, 'profile-a', [
      'automationRuns'
    ])
    expect(nullResult).toEqual({
      kind: 'values',
      revision: 1,
      values: new Map([['automationRuns', null]])
    })
  })

  it('does not resurrect a stale legacy automation row after normalized deletion', () => {
    const { databasePath } = createDatabase()
    const opened = openProfileStateDatabase(databasePath, 'profile-a')
    importProfileStateJson(
      opened.db,
      JSON.stringify({ automationRuns: [{ id: 'run-1', status: 'pending' }] })
    )
    writeProfileStateDomains(opened.db, {
      expectedRevision: 1,
      replacements: [{ domain: 'automationRuns', payload: null }]
    })
    opened.db.close()

    const result = readProfileStateDomains(databasePath, 'profile-a', ['automationRuns'])
    expect(result.kind).toBe('values')
    expect(result.kind === 'values' ? result.values.has('automationRuns') : true).toBe(false)
  })
})

it('reuses independently parsed values for selected domains and history rows', () => {
  const { databasePath } = createDatabase()
  const { db } = openProfileStateDatabase(databasePath, 'profile-a')
  const settings = '{"theme":"dark"}'
  const row = '{"id":"run-a","output":"retained"}'
  importProfileStateJson(db, `{"settings":${settings},"automationRuns":[${row}]}`)
  const parse = vi.spyOn(JSON, 'parse')
  try {
    expect(
      readProfileStateDomainsWithRevisionFromDatabase(db, ['settings', 'automationRuns'])
    ).toEqual({
      kind: 'values',
      revision: 1,
      values: new Map<string, unknown>([
        ['settings', { theme: 'dark' }],
        ['automationRuns', [{ id: 'run-a', output: 'retained' }]]
      ])
    })
    expect(parse.mock.calls.filter(([input]) => input === settings)).toHaveLength(1)
    expect(parse.mock.calls.filter(([input]) => input === row)).toHaveLength(1)
    expect(parse.mock.calls.some(([input]) => input === `[${row}]`)).toBe(false)
  } finally {
    parse.mockRestore()
    db.close()
  }
})
