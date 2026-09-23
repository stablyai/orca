import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openProfileStateDatabaseReadOnly,
  openProfileStateDatabase
} from './profile-state-database'
import { readProfileStateRevision } from './profile-state-documents'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'

const fixtures: { authority: ProfileStateSqliteAuthority; directory: string }[] = []

function fixture(established: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-complete-domain-write-'))
  const databasePath = join(directory, 'state.db')
  openProfileStateDatabase(databasePath, 'profile').db.close()
  const authority = new ProfileStateSqliteAuthority(databasePath, 'profile')
  fixtures.push({ authority, directory })
  if (established) {
    authority.writeSerializedState(
      Buffer.from('{"settings":{"theme":"light"},"automationRuns":[{"id":"old"}],"removeMe":true}')
    )
  }
  const readRevision = () => {
    const { db } = openProfileStateDatabaseReadOnly(databasePath, 'profile')
    try {
      return readProfileStateRevision(db)
    } finally {
      db.close()
    }
  }
  return { authority, databasePath, readRevision }
}

afterEach(() => {
  for (const { authority, directory } of fixtures.splice(0)) {
    authority.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

const invalidReplacements = [
  {
    name: 'sibling-key injection',
    value: [{ domain: 'extension', payload: 'null,"settings":{"theme":"dark"}' }]
  },
  {
    name: 'duplicate domains',
    value: [
      { domain: 'settings', payload: '{}' },
      { domain: 'settings', payload: 'null' }
    ]
  },
  { name: 'non-string payload', value: [{ domain: 'settings', payload: true }] },
  { name: 'missing payload', value: [{ domain: 'settings' }] },
  { name: 'empty domain', value: [{ domain: '', payload: '{}' }] },
  { name: 'non-array replacements', value: { settings: '{}' } }
]

describe.each([false, true])('complete domain writes (established: %s)', (established) => {
  it.each(invalidReplacements)('rejects $name without changing state or revision', ({ value }) => {
    const { authority, readRevision } = fixture(established)
    const before = authority.readSerializedState()
    const revision = readRevision()

    expect(() =>
      Reflect.apply(authority.writeCompleteSerializedDomains, authority, [value])
    ).toThrow()

    expect(authority.readSerializedState()).toBe(before)
    expect(readRevision()).toBe(revision)
  })

  it('preserves null, history order and unknown fields while deleting omitted domains', () => {
    const { authority } = fixture(established)
    const future = { '3': 3, '1': 1, unicode: '雪 🐋\ud800', nested: { z: null, a: [] } }
    const runs = [{ id: 'z', extension: future }, { id: 'a' }]

    authority.writeCompleteSerializedDomains([
      { domain: 'settings', payload: 'null' },
      { domain: 'automationRuns', payload: JSON.stringify(runs) },
      { domain: 'future', payload: JSON.stringify(future) },
      { domain: 'deleted', payload: null }
    ])

    expect(authority.readSerializedState()).toBe(
      JSON.stringify({ settings: null, automationRuns: runs, future })
    )
    authority.writeCompleteSerializedDomains([])
    expect(authority.readSerializedState()).toBe('{}')
  })

  it('accepts an empty complete profile', () => {
    const { authority } = fixture(established)

    authority.writeCompleteSerializedDomains([])

    expect(authority.readSerializedState()).toBe('{}')
  })
})

describe('complete domain revision fencing', () => {
  it('rejects an older complete replacement after a concurrent writer commits', () => {
    const { authority, databasePath } = fixture(true)
    authority.readSerializedState()
    const other = new ProfileStateSqliteAuthority(databasePath, 'profile')
    try {
      other.writeCompleteSerializedDomains([{ domain: 'settings', payload: '{"theme":"dark"}' }])
    } finally {
      other.close()
    }

    expect(() =>
      authority.writeCompleteSerializedDomains([
        { domain: 'settings', payload: '{"theme":"light"}' }
      ])
    ).toThrow(expect.objectContaining({ code: 'profile-state-revision-conflict' }))
    expect(authority.readSerializedState()).toBe('{"settings":{"theme":"dark"}}')
  })
})
