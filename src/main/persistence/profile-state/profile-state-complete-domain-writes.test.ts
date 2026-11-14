import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openProfileStateDatabaseReadOnly,
  openProfileStateDatabase
} from './database/profile-state-database'
import './documents/profile-state-documents'
import { readProfileStateRevision } from './database/profile-state-revision'
import { WorkspaceSessionFieldCapture } from '../loading-store/profile-writing/workspace-session-field-capture'
import { capturePreparedProfileStateWrite } from '../loading-store/profile-writing/profile-state-prepared-write'
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
  it.each([false, true])(
    'exports mixed domain kinds in capture order (complete=%s)',
    (complete) => {
      const { authority } = fixture(false)
      const fields = new WorkspaceSessionFieldCapture()
      fields.initialize()
      const stateToSave = { workspaceSession: { activeTabId: 't' }, marker: 'kept' }
      const captured = capturePreparedProfileStateWrite({
        fields,
        dirtyDomains: null,
        stateToSave,
        complete,
        serializeRoot: () => ({
          payload: Buffer.from(JSON.stringify(stateToSave)),
          stateHash: 'native',
          protectedSecretUpdates: []
        }),
        protectedSecretUpdates: []
      })
      if (captured.write) {
        authority.writePreparedState(captured.write)
      } else {
        authority.writeSerializedState(captured.payload)
      }
      expect(authority.readSerializedState()).toBe(
        '{"workspaceSession":{"activeTabId":"t"},"marker":"kept"}'
      )
    }
  )

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
