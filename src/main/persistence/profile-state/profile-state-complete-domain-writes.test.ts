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
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { profileStateWriterPatching as patching } from './documents/profile-state-patched-domains'

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

describe('complete writes with session patches', () => {
  it('keeps patched session domains and deletes only the domains it omits', () => {
    const { authority } = fixture(false)
    authority.writeSerializedState(
      Buffer.from(
        '{"settings":{"theme":"light"},"removeMe":true,' +
          '"workspaceSession":{"tabsByWorktree":{"w1":[1]},"activeTabId":"a"},' +
          '"workspaceSessionsByHostId":{"ssh:h":{"tabsByWorktree":{"w2":[2]}}}}'
      )
    )
    authority.writeCompleteSerializedDomains(
      [{ domain: 'settings', payload: '{"theme":"dark"}' }],
      {
        patching,
        patches: [
          {
            domain: 'workspaceSession',
            operations: [{ kind: 'set', path: ['tabsByWorktree', 'w3'], payload: '[3]' }]
          },
          { domain: 'workspaceSessionsByHostId', operations: [] }
        ]
      }
    )
    expect(JSON.parse(authority.readSerializedState()!)).toEqual({
      settings: { theme: 'dark' },
      workspaceSession: { tabsByWorktree: { w1: [1], w3: [3] }, activeTabId: 'a' },
      workspaceSessionsByHostId: { 'ssh:h': { tabsByWorktree: { w2: [2] } } }
    })
  })

  it('treats only unchanged session patches as a revision-checked no-op', () => {
    const { authority, readRevision } = fixture(false)
    authority.writeSerializedState(
      Buffer.from('{"workspaceSession":{"tabsByWorktree":{"w1":[1]}}}')
    )
    authority.writeCompleteSerializedDomains([], {
      patching,
      patches: [{ domain: 'workspaceSession', operations: [] }]
    })
    expect(readRevision()).toBe(1)
    expect(authority.readSerializedState()).toBe(
      '{"workspaceSession":{"tabsByWorktree":{"w1":[1]}}}'
    )
  })

  it('rejects a malformed session patch before keeping its domain', () => {
    const { authority } = fixture(false)
    authority.writeSerializedState(Buffer.from('{"settings":{},"workspaceSession":{"a":{"b":1}}}'))
    expect(() =>
      authority.writeCompleteSerializedDomains([{ domain: 'settings', payload: '{}' }], {
        patching,
        // Malformed wire data, as the writer protocol could deliver it.
        patches: JSON.parse('[{"domain":"workspaceSession","operations":{}}]')
      })
    ).toThrow('Profile state patch domain is invalid or repeated')
  })
})
