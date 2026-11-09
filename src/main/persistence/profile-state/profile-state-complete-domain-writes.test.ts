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
