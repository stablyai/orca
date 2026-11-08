import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import { openProfileStateDatabaseReadOnly } from '../profile-state/profile-state-database'
import { parseProfileStateRoot } from '../profile-state/profile-state-document-validation'
import { readProfileStateSnapshot } from '../profile-state/profile-state-documents'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { Store } from './store'
import { scheduleSave } from './write-scheduling'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const PROFILE_ID = 'checkpoint-test'
const fixtures: { directory: string; store: Store }[] = []

afterEach(async () => {
  for (const { directory, store } of fixtures.splice(0)) {
    store.freezeWrites()
    await store.flushAsync()
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-checkpoint-'))
  const databasePath = join(directory, 'profile-state.db')
  const dataFile = join(directory, 'orca-data.json')
  const authority = new ProfileStateSqliteAuthority(databasePath, PROFILE_ID)
  const backup = vi.spyOn(authority, 'scheduleBackup').mockImplementation(() => {})
  authority.writeSerializedState(
    Buffer.from(JSON.stringify(buildProfileStateCutoverFixture(directory)))
  )
  const store = new Store({ dataFile, profileStateAuthority: authority })
  fixtures.push({ directory, store })
  store.flushOrThrow()
  return {
    directory,
    dataFile,
    store,
    authority,
    backup,
    readState: () => {
      const opened = openProfileStateDatabaseReadOnly(databasePath, PROFILE_ID)
      try {
        return parseProfileStateRoot(readProfileStateSnapshot(opened.db).json)
      } finally {
        opened.db.close()
      }
    }
  }
}

function mutateThroughGetters(store: Store): void {
  store.getWorkspaceSession().activeTabId = 'direct-local-tab'
  store.getWorkspaceSession('ssh:build-host').activeTabId = 'direct-remote-tab'
}

const EXPECTED_CHECKPOINT = {
  settings: { theme: 'dark' },
  workspaceSession: { activeTabId: 'direct-local-tab' },
  workspaceSessionsByHostId: { 'ssh:build-host': { activeTabId: 'direct-remote-tab' } }
}

describe('complete profile state checkpoints', () => {
  it.each(['sync', 'async'] as const)(
    'rejects a stale %s checkpoint even when the local hash is unchanged',
    async (mode) => {
      const { store, directory, readState } = fixture()
      const other = new ProfileStateSqliteAuthority(join(directory, 'profile-state.db'), PROFILE_ID)
      try {
        other.readSerializedState()
        other.writeSerializedDomains([{ domain: 'futureDomain', payload: '{"external":true}' }])
        scheduleSave(store)
        if (mode === 'sync') {
          expect(() => store.flushOrThrow()).toThrow(/Profile state revision changed/)
        } else {
          await expect(store.flushPendingOrThrowAsync()).rejects.toThrow(
            /Profile state revision changed/
          )
        }
        expect(readState()).toMatchObject({ futureDomain: { external: true } })
      } finally {
        other.close()
      }
    }
  )

  it('takes the final checkpoint after an earlier queued writer clears its dirty domains', async () => {
    const { store, backup, readState } = fixture()
    store.updateSettings({ theme: 'light' })
    backup.mockImplementationOnce(() => {
      queueMicrotask(() => {
        mutateThroughGetters(store)
        store.updateSettings({ theme: 'dark' })
      })
    })

    const previous = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    const final = store.flushAsync()
    await Promise.all([previous, final])

    expect(readState()).toMatchObject(EXPECTED_CHECKPOINT)
  })

  it('does not write a frozen profile when final persistence requests a checkpoint', async () => {
    const { store, authority, readState } = fixture()
    const before = readState()
    const fullWrite = vi.spyOn(authority, 'writeSerializedState')
    mutateThroughGetters(store)
    store.updateSettings({ theme: 'dark' })
    store.freezeWrites()

    await store.flushAsync()

    expect(fullWrite).not.toHaveBeenCalled()
    expect(readState()).toEqual(before)
  })
})
