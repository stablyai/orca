import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSecretStore, setSecretStore } from '../../shared/secret-store'
import {
  createWorkerMaintenanceFixture,
  createSqliteMaintenanceFixture,
  maintenanceBarrier
} from './loading-store/profile-writing/profile-state-maintenance-fixture'
import { Store } from './loading-store/store'

vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

let encryptionAvailable = true
let previousSecretStore: ReturnType<typeof getSecretStore>

beforeEach(() => {
  encryptionAvailable = true
  previousSecretStore = getSecretStore()
  setSecretStore({
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (ciphertext) => ciphertext.toString('utf8').slice('enc:'.length),
    describeProtectionGap: () => null
  })
})
afterEach(() => setSecretStore(previousSecretStore))

describe('protected-secret async write retention', () => {
  it('keeps a repeated complete flush fenced without publishing fresh ciphertext', async () => {
    let nonce = 0
    setSecretStore({
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (plaintext) => Buffer.from(JSON.stringify([++nonce, plaintext])),
      decryptString: (ciphertext) => JSON.parse(ciphertext.toString())[1],
      describeProtectionGap: () => null
    })
    const { store, peer, readState } = await createWorkerMaintenanceFixture()
    store.updateSettings({ opencodeSessionCookie: 'synthetic-cookie' })
    await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
    const saved = readState().settings.opencodeSessionCookie
    const revision = () => {
      const reader = peer()
      try {
        reader.readSerializedState()
        return reader.revision
      } finally {
        reader.close()
      }
    }
    const before = revision()
    await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
    expect(revision()).toBe(before)
    expect(readState().settings.opencodeSessionCookie).toBe(saved)

    // The skipped capture's ciphertext must not become the degraded-retention value.
    encryptionAvailable = false
    await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
    expect(readState().settings.opencodeSessionCookie).toBe(saved)
    encryptionAvailable = true
    store.updateSettings({ opencodeSessionCookie: 'changed-cookie' })
    store.getWorkspaceSession().activeTabId = 'getter-change'
    await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
    const changed = readState()
    expect(
      JSON.parse(Buffer.from(changed.settings.opencodeSessionCookie, 'base64').toString())[1]
    ).toBe('changed-cookie')
    expect(changed.workspaceSession.activeTabId).toBe('getter-change')

    await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
    const competitor = peer()
    try {
      competitor.readSerializedState()
      competitor.writeSerializedDomains([{ domain: 'peer', payload: '1' }])
    } finally {
      competitor.close()
    }
    await expect(store.flushPendingOrThrowAsync({ fullCheckpoint: true })).rejects.toMatchObject({
      code: 'profile-state-revision-conflict'
    })
  })

  it.each(['worker', 'sync'])(
    'persists a recovered proxy while a cookie remains pending (%s)',
    async (mode) => {
      let proxyRecovered = false
      const proxy = 'http://synthetic.invalid:8080'
      setSecretStore({
        isEncryptionAvailable: () => true,
        encryptString: (plaintext) => {
          if (plaintext === 'synthetic-cookie' || (plaintext === proxy && !proxyRecovered)) {
            throw new Error('synthetic encryption failure')
          }
          return Buffer.from(`enc:${plaintext}`)
        },
        decryptString: (ciphertext) => ciphertext.toString().slice(4),
        describeProtectionGap: () => null
      })
      const fixture =
        mode === 'worker'
          ? await createWorkerMaintenanceFixture()
          : createSqliteMaintenanceFixture()
      const { store } = fixture
      store.updateSettings({ opencodeSessionCookie: '' })
      await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
      const readSettings = () =>
        'readState' in fixture
          ? fixture.readState().settings
          : JSON.parse(fixture.authority.readSerializedState() ?? '{}').settings
      store.updateSettings({ opencodeSessionCookie: 'synthetic-cookie', httpProxyUrl: proxy })
      await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
      expect(readSettings().httpProxyUrl).toBe('')
      proxyRecovered = true
      await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
      expect(readSettings().httpProxyUrl).toBe(Buffer.from(`enc:${proxy}`).toString('base64'))
      expect(readSettings().opencodeSessionCookie).toBe('')
    }
  )

  it('does not retain ciphertext from a rejected worker write after a newer secret arrives', async () => {
    const { store, authority, peer, dataFile, readState } = await createWorkerMaintenanceFixture()
    store.updateSettings({ opencodeSessionCookie: 'durable-cookie' })
    await store.flushPendingOrThrowAsync()
    const durableCiphertext = readState().settings.opencodeSessionCookie
    const entered = maintenanceBarrier()
    const release = maintenanceBarrier()
    const writeDomains = authority.writeSerializedDomains.bind(authority)
    const pendingWrite = vi
      .spyOn(authority, 'writePreparedState')
      .mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
        await writeDomains([{ domain: 'settings', payload: '{' }])
      })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    store.updateSettings({ opencodeSessionCookie: 'intermediate-cookie' })
    const writing = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    const rejected = expect(writing).rejects.toMatchObject({ outcome: 'known-failure' })
    await entered.promise
    store.updateSettings({ opencodeSessionCookie: 'replacement-cookie' })
    encryptionAvailable = false
    release.resolve()
    await rejected
    pendingWrite.mockRestore()
    await store.flushPendingOrThrowAsync()

    expect(readState().settings.opencodeSessionCookie).toBe(durableCiphertext)
    expect(store.getSettings().opencodeSessionCookie).toBe('replacement-cookie')
    encryptionAvailable = true
    const restarted = new Store({ dataFile, profileStateAuthority: peer() })
    try {
      expect(restarted.getSettings().opencodeSessionCookie).toBe('durable-cookie')
    } finally {
      restarted.freezeWrites()
    }

    store.updateSettings({ theme: 'dark' })
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.opencodeSessionCookie).toBe(
      Buffer.from('enc:replacement-cookie').toString('base64')
    )
  })
})
