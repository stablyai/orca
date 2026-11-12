import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../../shared/constants'
import { setSecretStore } from '../../../../shared/secret-store'
import { buildProfileStateCutoverFixture } from '../../profile-state-cutover-fixture'
import { openProfileStateDatabaseReadOnly } from '../../profile-state/database/profile-state-database'
import { readProfileStateSnapshot } from '../../profile-state/documents/profile-state-documents'
import { parseProfileStateRoot } from '../../profile-state/documents/profile-state-document-validation'
import { ProfileStateSqliteAuthority } from '../../profile-state/profile-state-sqlite-authority'
import { Store } from '../store'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const ORIGINAL = {
  opencodeSessionCookie: 'original-cookie',
  httpProxyUrl: 'http://original:password@proxy.test:8080'
}
type Failure = 'none' | 'unavailable' | 'availability' | 'encryption' | 'decryption'
let failure: Failure = 'none'
let nonce = 0
const directories: string[] = []
const stores: Store[] = []

beforeEach(() => {
  failure = 'none'
  nonce = 0
  setSecretStore({
    isEncryptionAvailable: () => {
      if (failure === 'availability') {
        throw new Error('keychain unavailable')
      }
      return failure !== 'unavailable'
    },
    encryptString: (plaintext) => {
      if (failure === 'encryption') {
        throw new Error('encryption failed')
      }
      return Buffer.from(`cipher:${++nonce}:${plaintext}`)
    },
    decryptString: (ciphertext) => {
      if (failure === 'decryption') {
        throw new Error('decryption failed')
      }
      const value = ciphertext.toString()
      if (!value.startsWith('cipher:')) {
        throw new Error('invalid ciphertext')
      }
      return value.slice(value.indexOf(':', 'cipher:'.length) + 1)
    },
    describeProtectionGap: () => null
  })
  vi.spyOn(ProfileStateSqliteAuthority.prototype, 'scheduleBackup').mockImplementation(() => {})
})

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
    await store.flushAsync()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-settings-domain-'))
  directories.push(directory)
  const databasePath = join(directory, 'profile-state.db')
  const dataFile = join(directory, 'orca-data.json')
  const profileId = 'settings-domain'
  const authority = new ProfileStateSqliteAuthority(databasePath, profileId)
  const fixtureState = buildProfileStateCutoverFixture(directory)
  authority.writeSerializedState(
    Buffer.from(
      JSON.stringify({
        ...getDefaultPersistedState(directory),
        automationRuns: fixtureState.automationRuns,
        futureTopLevelExtension: fixtureState.futureTopLevelExtension
      })
    )
  )
  const createStore = (storage = new ProfileStateSqliteAuthority(databasePath, profileId)) => {
    const store = new Store({ dataFile, profileStateAuthority: storage })
    stores.push(store)
    return store
  }
  const store = createStore(authority)
  store.updateSettings(ORIGINAL)
  store.flushOrThrow()
  const read = () => {
    const opened = openProfileStateDatabaseReadOnly(databasePath, profileId)
    try {
      return {
        state: parseProfileStateRoot(readProfileStateSnapshot(opened.db).json),
        otherDocuments: opened.db
          .prepare(
            "SELECT * FROM profile_state_documents WHERE domain <> 'settings' ORDER BY rowid"
          )
          .all(),
        runs: opened.db.prepare('SELECT * FROM profile_state_automation_runs ORDER BY run_id').all()
      }
    } finally {
      opened.db.close()
    }
  }
  return { store, authority, read, reopen: () => createStore() }
}

describe('selective SQLite settings persistence', () => {
  it('keeps an explicit UI secret clear after an unavailable write and later settings save', async () => {
    const state = fixture()
    state.store.updateUI({ browserKagiSessionLink: 'original-link' })
    await state.store.flushPendingOrThrowAsync()
    failure = 'unavailable'
    state.store.updateUI({ browserKagiSessionLink: 'pending-link' })
    await state.store.flushPendingOrThrowAsync()
    state.store.updateUI({ browserKagiSessionLink: null })
    await state.store.flushPendingOrThrowAsync()
    failure = 'none'
    state.store.updateSettings({ terminalFontSize: 28 })
    await state.store.flushPendingOrThrowAsync()
    expect(state.reopen().getUI().browserKagiSessionLink).toBeNull()
  })
})
