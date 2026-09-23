import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../loading-store/store'
import { openProfileStateDatabase } from './profile-state-database'
import {
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateSnapshot,
  readProfileStateParsedSnapshot
} from './profile-state-documents'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { createProfileStateStore } from './profile-state-store-factory'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(keepJson = false) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-fragments-'))
  directories.push(directory)
  const paths = {
    dataFile: join(directory, 'orca-data.json'),
    databaseFile: join(directory, 'profile-state.db'),
    profileId: 'fragment-validation'
  }
  const source = JSON.stringify({
    settings: { theme: 'dark' },
    futureDomain: null,
    automationRuns: [{ id: 'a' }, { id: 'b' }]
  })
  if (keepJson) {
    writeFileSync(paths.dataFile, source)
  }
  const { db } = openProfileStateDatabase(paths.databaseFile, paths.profileId)
  importProfileStateJson(db, source, { acceptedLegacyJsonHash: hashProfileStateJson(source) })
  return { paths, db }
}

describe('independent profile state JSON fragments', () => {
  it.each([false, true])(
    'rejects a domain that injects a valid sibling into startup JSON (retained JSON: %s)',
    (keepJson) => {
      const { paths, db } = fixture(keepJson)
      const payload = 'null,"settings":{"theme":"light"}'
      db.prepare(
        'UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = ?'
      ).run(payload, hashProfileStateJson(payload), 'futureDomain')
      expect(() => readProfileStateParsedSnapshot(db)).toThrow(/invalid JSON: futureDomain/)
      db.close()

      expect(() => {
        const result = createProfileStateStore({ ...paths, authorityMode: 'sqlite-established' })
        result.store.freezeWrites()
      }).toThrow()
    }
  )

  it('rejects a spliced domain through direct authority and Store reads', () => {
    const { paths, db } = fixture()
    const payload = 'null,"settings":{"theme":"light"}'
    db.prepare(
      'UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = ?'
    ).run(payload, hashProfileStateJson(payload), 'futureDomain')
    db.close()
    const authority = new ProfileStateSqliteAuthority(paths.databaseFile, paths.profileId)
    try {
      expect(() => {
        const store = new Store({ dataFile: paths.dataFile, profileStateAuthority: authority })
        store.freezeWrites()
      }).toThrow(/invalid JSON: futureDomain/)
      expect(() => authority.readSerializedState()).toThrow(/invalid JSON: futureDomain/)
    } finally {
      authority.close()
    }
  })

  it.each(['snapshot', 'parsed', 'authority', 'store'] as const)(
    'rejects history rows that form a valid array only when spliced together (%s)',
    (boundary) => {
      const { paths, db } = fixture()
      const payloads = ['{"id":"a","text":"', 'b"},{"id":"b"}']
      const aggregate = `[${payloads.join(',')}]`
      expect(JSON.parse(aggregate)).toEqual([{ id: 'a', text: ',b' }, { id: 'b' }])
      for (const [ordinal, payload] of payloads.entries()) {
        expect(() => JSON.parse(payload)).toThrow()
        db.prepare(
          'UPDATE profile_state_automation_runs SET payload = ?, content_hash = ? WHERE ordinal = ?'
        ).run(payload, hashProfileStateJson(payload), ordinal)
      }
      db.prepare('UPDATE profile_state_automation_runs_meta SET content_hash = ?').run(
        hashProfileStateJson(aggregate)
      )
      const authority = new ProfileStateSqliteAuthority(paths.databaseFile, paths.profileId)
      try {
        expect(() => {
          if (boundary === 'snapshot') {
            readProfileStateSnapshot(db)
          } else if (boundary === 'parsed') {
            readProfileStateParsedSnapshot(db)
          } else if (boundary === 'authority') {
            authority.readSerializedState()
          } else {
            const store = new Store({ dataFile: paths.dataFile, profileStateAuthority: authority })
            store.freezeWrites()
          }
        }).toThrow('Normalized automationRuns row is invalid JSON')
      } finally {
        authority.close()
        db.close()
      }
    }
  )
})
