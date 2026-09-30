import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { setSecretStore } from '../../../shared/secret-store'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import { openProfileStateDatabaseReadOnly } from '../profile-state/profile-state-database'
import { readProfileStateSnapshot } from '../profile-state/profile-state-documents'
import { parseProfileStateRoot } from '../profile-state/profile-state-document-validation'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { Store } from './store'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
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
  it.each(['sync', 'async'] as const)(
    'saves settings through the %s barrier without rewriting history or unknown domains',
    async (mode) => {
      const state = fixture()
      const before = state.read()
      const wholeWrite = vi.spyOn(state.authority, 'writeCompleteSerializedDomains')
      state.store.updateSettings({ terminalFontSize: 19, httpProxyBypassRules: '*.internal' })
      if (mode === 'sync') {
        state.store.flushOrThrow()
      } else {
        await state.store.flushPendingOrThrowAsync()
      }
      expect(wholeWrite).not.toHaveBeenCalled()
      const after = state.read()
      expect(after.otherDocuments).toEqual(before.otherDocuments)
      expect(after.runs).toEqual(before.runs)
      expect(after.state).toMatchObject({
        settings: { terminalFontSize: 19, httpProxyBypassRules: '*.internal' },
        futureTopLevelExtension: before.state.futureTopLevelExtension
      })
      expect(JSON.stringify(after.state)).not.toContain(ORIGINAL.opencodeSessionCookie)
      expect(JSON.stringify(after.state)).not.toContain(ORIGINAL.httpProxyUrl)
      expect(state.reopen().getSettings()).toMatchObject({ ...ORIGINAL, terminalFontSize: 19 })
    }
  )

  it.each(['unavailable', 'availability', 'encryption'] as const)(
    'retains committed secrets while %s and retries them after recovery',
    async (mode) => {
      const state = fixture()
      const before = state.read()
      failure = mode
      state.store.updateSettings({ opencodeSessionCookie: 'pending-cookie', terminalFontSize: 18 })
      await state.store.flushPendingOrThrowAsync()
      expect(state.read().state.settings).toEqual({
        ...getSettingsRecord(before.state),
        terminalFontSize: 18
      })
      failure = 'none'
      state.store.updateSettings({ terminalFontSize: 20 })
      await state.store.flushPendingOrThrowAsync()
      expect(state.reopen().getSettings()).toMatchObject({
        ...ORIGINAL,
        opencodeSessionCookie: 'pending-cookie',
        terminalFontSize: 20
      })
    }
  )

  it('preserves sealed settings on unrelated saves and permits an explicit clear', () => {
    const state = fixture()
    const before = state.read()
    state.store.freezeWrites()
    failure = 'decryption'
    const sealed = state.reopen()
    sealed.flushOrThrow()
    expect(sealed.getSettings().opencodeSessionCookie).toBe('')
    sealed.updateSettings({ terminalFontSize: 21 })
    sealed.flushOrThrow()
    expect(state.read().state.settings).toEqual({
      ...getSettingsRecord(before.state),
      terminalFontSize: 21
    })
    sealed.updateSettings({ opencodeSessionCookie: '', httpProxyUrl: '' })
    sealed.flushOrThrow()
    failure = 'none'
    expect(state.reopen().getSettings()).toMatchObject({
      opencodeSessionCookie: '',
      httpProxyUrl: '',
      terminalFontSize: 21
    })
  })

  it('does not retain ciphertext from a failed selective commit', () => {
    const state = fixture()
    const before = state.read()
    vi.spyOn(state.authority, 'writeSerializedDomains').mockImplementationOnce(() => {
      throw new Error('commit failed')
    })
    state.store.updateSettings({ opencodeSessionCookie: 'uncommitted-cookie' })
    expect(() => state.store.flushOrThrow()).toThrow('commit failed')
    expect(state.read()).toEqual(before)
    failure = 'unavailable'
    state.store.updateSettings({ terminalFontSize: 22 })
    state.store.flushOrThrow()
    failure = 'none'
    expect(state.reopen().getSettings()).toMatchObject({ ...ORIGINAL, terminalFontSize: 22 })
  })

  it('commits pending session/settings domains together and falls back for unclassified updates', () => {
    const state = fixture()
    state.store.patchWorkspaceSession({ activeTabId: 'pending-tab' })
    state.store.updateSettings({ terminalFontSize: 23 })
    state.store.flushOrThrow()
    expect(state.read().state).toMatchObject({
      settings: { terminalFontSize: 23 },
      workspaceSession: { activeTabId: 'pending-tab' }
    })
    const wholeWrite = vi.spyOn(state.authority, 'writeCompleteSerializedDomains')
    state.store.updateSettings({ terminalFontSize: 24 })
    state.store.updateOnboarding({ outcome: 'completed' })
    state.store.flushOrThrow()
    expect(wholeWrite).toHaveBeenCalledOnce()
    expect(state.read().state).toMatchObject({
      settings: { terminalFontSize: 24 },
      onboarding: { outcome: 'completed' }
    })
  })

  it.each(['unavailable', 'encryption'] as const)(
    'retries deferred UI and SSH secrets on a settings save after %s recovers',
    async (mode) => {
      const state = fixture()
      const recovery = {
        targetId: 'ssh-test',
        clientInstanceId: 'client-test',
        serverBuildId: 'build-test',
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: 'original-lease'
      }
      state.store.updateUI({ browserKagiSessionLink: 'original-link' })
      await state.store.upsertSshPtyConsumerRecovery(recovery)
      const before = state.read().state

      failure = mode
      state.store.updateUI({ browserKagiSessionLink: 'pending-link' })
      await state.store.flushPendingOrThrowAsync()
      await state.store.upsertSshPtyConsumerRecovery({ ...recovery, ownerLease: 'pending-lease' })
      expect(state.read().state).toMatchObject({
        ui: before.ui,
        sshPtyConsumerRecoveries: before.sshPtyConsumerRecoveries
      })

      failure = 'none'
      const wholeWrite = vi.spyOn(state.authority, 'writeCompleteSerializedDomains')
      wholeWrite.mockImplementationOnce(() => {
        throw new Error('recovery commit failed')
      })
      state.store.updateSettings({ terminalFontSize: 25 })
      await expect(state.store.flushPendingOrThrowAsync()).rejects.toThrow('recovery commit failed')
      expect(state.read().state).toMatchObject({
        ui: before.ui,
        sshPtyConsumerRecoveries: before.sshPtyConsumerRecoveries
      })
      state.store.updateSettings({ terminalFontSize: 26 })
      await state.store.flushPendingOrThrowAsync()
      expect(wholeWrite).toHaveBeenCalledTimes(2)
      const reopened = state.reopen()
      expect(reopened.getUI().browserKagiSessionLink).toBe('pending-link')
      expect(reopened.getSshPtyConsumerRecovery('ssh-test')?.ownerLease).toBe('pending-lease')
      expect(JSON.stringify(state.read().state)).not.toMatch(/pending-link|pending-lease/)

      state.store.updateSettings({ terminalFontSize: 27 })
      await state.store.flushPendingOrThrowAsync()
      expect(wholeWrite).toHaveBeenCalledTimes(2)
    }
  )

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

  it.each(['unavailable', 'decryption'] as const)(
    'persists an explicit empty UI secret clear after reopening with %s secrets',
    async (mode) => {
      const state = fixture()
      state.store.updateUI({ browserKagiSessionLink: 'original-link' })
      await state.store.flushPendingOrThrowAsync()
      state.store.freezeWrites()
      failure = mode
      const sealed = state.reopen()
      await sealed.flushPendingOrThrowAsync()
      expect(sealed.getUI().browserKagiSessionLink).toBe('')
      sealed.updateUI({ browserKagiSessionLink: '' })
      sealed.updateSettings({ terminalFontSize: 29 })
      await sealed.flushPendingOrThrowAsync()
      failure = 'none'
      expect(state.reopen().getUI().browserKagiSessionLink).toBeNull()
    }
  )
})

function getSettingsRecord(state: Record<string, unknown>): Record<string, unknown> {
  const settings = state.settings
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('Expected persisted settings')
  }
  return Object.fromEntries(Object.entries(settings))
}
