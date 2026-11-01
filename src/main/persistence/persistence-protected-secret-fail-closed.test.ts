import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from './persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

type FailureMode = 'availability-throws' | 'encryption-throws' | 'unavailable'

const testState = { dir: '' }
const cipherState = {
  availability: 'available' as 'available' | 'throws' | 'unavailable',
  encryptionThrows: false,
  decryptionThrows: false
}

vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir }
}))

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))

async function createStore() {
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => {
      if (cipherState.availability === 'throws') {
        throw new Error('keychain access denied')
      }
      return cipherState.availability === 'available'
    },
    encryptString: (plaintext) => {
      if (cipherState.encryptionThrows) {
        throw new Error('keychain encryption failed')
      }
      return Buffer.from(`enc:${randomUUID()}:${plaintext}`, 'utf-8')
    },
    decryptString: (ciphertext) => {
      if (cipherState.decryptionThrows) {
        throw new Error('keychain decryption failed')
      }
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('enc:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('enc:'.length + 36 + 1)
    },
    describeProtectionGap: () => null
  })
  const { Store } = await import('./loading-store/store')
  const { initDataPath } = await import('./loading-store/user-data-path')
  // Reopened stores must use this fixture’s userData directory.
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

type ProtectedState = {
  settings: {
    httpProxyUrl: string
    httpProxyBypassRules: string
    opencodeSessionCookie: string
  }
  ui: { browserKagiSessionLink: string | null }
  sshPtyConsumerRecoveries: { ownerLease: string }[]
}

function readState(path = dataFile()): ProtectedState {
  return JSON.parse(readPersistedStateJson(path))
}

const ORIGINAL = {
  proxy: 'http://old-user:old-pass@proxy.test:8080',
  cookie: 'old-opencode-cookie',
  kagi: 'https://kagi.test/session/old-token'
} as const
const PENDING = {
  proxy: 'http://new-user:new-pass@proxy.test:8080',
  cookie: 'new-opencode-cookie',
  kagi: 'https://kagi.test/session/new-token'
} as const
// Preserve relay-era owner leases sealed so downgrades can still read them.
const OWNER_LEASE = `old-ssh-owner-lease-${'x'.repeat(480)}`
const sealOwnerLease = (lease: string) =>
  Buffer.from(`enc:${randomUUID()}:${lease}`, 'utf-8').toString('base64')
const openOwnerLease = (ciphertext: string | undefined) =>
  Buffer.from(ciphertext ?? '', 'base64')
    .toString('utf-8')
    .slice('enc:'.length + 36 + 1)

function seedRelayEraRecovery(ownerLease = sealOwnerLease(OWNER_LEASE)): void {
  writeFileSync(
    dataFile(),
    JSON.stringify({
      sshPtyConsumerRecoveries: [
        {
          targetId: 'ssh-1',
          clientInstanceId: 'client-1',
          serverBuildId: 'relay-build-1',
          clientGeneration: 1,
          ownerGeneration: 1,
          ownerLease
        }
      ]
    })
  )
}

function setFailure(mode: FailureMode): void {
  cipherState.availability =
    mode === 'availability-throws' ? 'throws' : mode === 'unavailable' ? 'unavailable' : 'available'
  cipherState.encryptionThrows = mode === 'encryption-throws'
}

async function writeProtectedState(
  store: Awaited<ReturnType<typeof createStore>>,
  values: typeof ORIGINAL | typeof PENDING,
  bypassRules: string
): Promise<void> {
  store.updateSettings({
    httpProxyUrl: values.proxy,
    httpProxyBypassRules: bypassRules,
    opencodeSessionCookie: values.cookie
  })
  store.updateUI({ browserKagiSessionLink: values.kagi })
  await settleSave(store)
}

function expectPlaintextsAbsent(raw: string, values: typeof ORIGINAL | typeof PENDING): void {
  for (const plaintext of Object.values(values)) {
    expect.soft(raw).not.toContain(plaintext)
  }
}

async function settleSave(store: Awaited<ReturnType<typeof createStore>>): Promise<void> {
  vi.advanceTimersByTime(2_000)
  await store.waitForPendingWrite()
}

describe('protected persistence when safeStorage fails', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-safe-storage-test-'))
    cipherState.availability = 'available'
    cipherState.encryptionThrows = false
    cipherState.decryptionThrows = false
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it.each<FailureMode>(['availability-throws', 'encryption-throws', 'unavailable'])(
    'omits newly introduced protected values during a persistent failure: %s',
    async (failureMode) => {
      setFailure(failureMode)
      const store = await createStore()
      await writeProtectedState(store, PENDING, 'non-secret-saved')

      const raw = readPersistedStateJson(dataFile())
      const persisted = readState()
      expectPlaintextsAbsent(raw, PENDING)
      expect(persisted.settings.httpProxyUrl).toBe('')
      expect(persisted.settings.opencodeSessionCookie).toBe('')
      expect(persisted.ui.browserKagiSessionLink).toBe('')
      expect(persisted.settings.httpProxyBypassRules).toBe('non-secret-saved')
    }
  )

  it.each<FailureMode>(['availability-throws', 'encryption-throws', 'unavailable'])(
    'persists the pending protected state after same-instance recovery: %s',
    async (failureMode) => {
      const store = await createStore()
      await writeProtectedState(store, ORIGINAL, 'before')
      setFailure(failureMode)
      await writeProtectedState(store, PENDING, 'during-failure')

      cipherState.availability = 'available'
      cipherState.encryptionThrows = false
      await writeProtectedState(store, PENDING, 'during-failure')

      const restarted = await createStore()
      expect(restarted.getSettings().httpProxyUrl).toBe(PENDING.proxy)
      expect(restarted.getSettings().opencodeSessionCookie).toBe(PENDING.cookie)
      expect(restarted.getUI().browserKagiSessionLink).toBe(PENDING.kagi)
    }
  )

  it('honors explicit clears during an outage without later resurrecting ciphertext', async () => {
    const store = await createStore()
    await writeProtectedState(store, ORIGINAL, 'before')
    cipherState.availability = 'unavailable'

    store.updateSettings({ httpProxyUrl: '', opencodeSessionCookie: '' })
    store.updateUI({ browserKagiSessionLink: null })
    await settleSave(store)

    await writeProtectedState(store, PENDING, 'after-clear')
    const persisted = readState()
    expect(persisted.settings.httpProxyUrl).toBe('')
    expect(persisted.settings.opencodeSessionCookie).toBe('')
    expect(persisted.ui.browserKagiSessionLink).toBe('')

    cipherState.availability = 'available'
    const restarted = await createStore()
    expect(restarted.getSettings().httpProxyUrl).toBe('')
    expect(restarted.getSettings().opencodeSessionCookie).toBe('')
    expect(restarted.getUI().browserKagiSessionLink).toBe('')
  })

  it('persists clears after a healthy save preserves sealed ciphertext', async () => {
    const initial = await createStore()
    await writeProtectedState(initial, ORIGINAL, 'before')
    const originalCiphertext = readState()

    cipherState.availability = 'unavailable'
    const sealed = await createStore()
    expect(sealed.getSettings().httpProxyUrl).toBe('')
    expect(sealed.getSettings().opencodeSessionCookie).toBe('')

    cipherState.availability = 'available'
    sealed.updateSettings({ httpProxyBypassRules: 'healthy-preserve' })
    await settleSave(sealed)
    expect(readState().settings.httpProxyUrl).toBe(originalCiphertext.settings.httpProxyUrl)
    expect(readState().settings.opencodeSessionCookie).toBe(
      originalCiphertext.settings.opencodeSessionCookie
    )

    sealed.updateSettings({ httpProxyUrl: '', opencodeSessionCookie: '' })
    await settleSave(sealed)
    expect(readState().settings.httpProxyUrl).toBe('')
    expect(readState().settings.opencodeSessionCookie).toBe('')
  })

  it('JSON-escapes retained legacy plaintext while storage is unavailable', async () => {
    const legacyCookie = 'legacy-"cookie\\value'
    writeFileSync(dataFile(), JSON.stringify({ settings: { opencodeSessionCookie: legacyCookie } }))
    cipherState.availability = 'unavailable'
    const store = await createStore()

    store.updateSettings({ opencodeSessionCookie: PENDING.cookie })
    await settleSave(store)

    expect(readState().settings.opencodeSessionCookie).toBe(legacyCookie)
  })

  it('evicts ciphertext when decrypted SSH recovery validation rejects the record', async () => {
    seedRelayEraRecovery(sealOwnerLease('z'.repeat(513)))
    const store = await createStore()

    cipherState.availability = 'unavailable'
    store.updateSettings({ httpProxyBypassRules: 'after-eviction' })
    await settleSave(store)

    expect(readState().sshPtyConsumerRecoveries).toEqual([])
  })

  it('keeps loaded ciphertext sealed through same-instance recovery', async () => {
    seedRelayEraRecovery()
    const initial = await createStore()
    await writeProtectedState(initial, ORIGINAL, 'before')
    const originalCiphertext = readState()

    cipherState.availability = 'unavailable'
    const sealed = await createStore()
    expect(sealed.getSettings().httpProxyUrl).toBe('')
    expect(sealed.getSettings().opencodeSessionCookie).toBe('')
    expect(sealed.getUI().browserKagiSessionLink).toBe('')

    sealed.updateSettings({ httpProxyBypassRules: 'during-outage' })
    await settleSave(sealed)
    expect(readState().settings.opencodeSessionCookie).toBe(
      originalCiphertext.settings.opencodeSessionCookie
    )

    cipherState.availability = 'available'
    sealed.updateSettings({ httpProxyBypassRules: 'after-recovery' })
    await settleSave(sealed)
    expect(readState()).toMatchObject({
      settings: {
        httpProxyUrl: originalCiphertext.settings.httpProxyUrl,
        opencodeSessionCookie: originalCiphertext.settings.opencodeSessionCookie
      },
      ui: { browserKagiSessionLink: originalCiphertext.ui.browserKagiSessionLink },
      sshPtyConsumerRecoveries: [
        { ownerLease: originalCiphertext.sshPtyConsumerRecoveries[0]?.ownerLease }
      ]
    })

    const restarted = await createStore()
    expect(restarted.getSettings().httpProxyUrl).toBe(ORIGINAL.proxy)
    expect(restarted.getSettings().opencodeSessionCookie).toBe(ORIGINAL.cookie)
    expect(restarted.getUI().browserKagiSessionLink).toBe(ORIGINAL.kagi)
    expect(restarted.getSettings().httpProxyBypassRules).toBe('after-recovery')
    expect(openOwnerLease(readState().sshPtyConsumerRecoveries[0]?.ownerLease)).toBe(OWNER_LEASE)
  })

  it('keeps undecryptable ciphertext sealed from consumers and later saves', async () => {
    seedRelayEraRecovery()
    const initial = await createStore()
    await writeProtectedState(initial, ORIGINAL, 'before')
    const originalCiphertext = readState()

    cipherState.decryptionThrows = true
    const sealed = await createStore()
    expect(sealed.getSettings().httpProxyUrl).toBe('')
    expect(sealed.getSettings().opencodeSessionCookie).toBe('')
    expect(sealed.getUI().browserKagiSessionLink).toBe('')

    sealed.updateSettings({ httpProxyBypassRules: 'decryption-failed' })
    await settleSave(sealed)
    expect(readState()).toMatchObject({
      settings: {
        httpProxyUrl: originalCiphertext.settings.httpProxyUrl,
        opencodeSessionCookie: originalCiphertext.settings.opencodeSessionCookie
      },
      ui: { browserKagiSessionLink: originalCiphertext.ui.browserKagiSessionLink },
      sshPtyConsumerRecoveries: [
        { ownerLease: originalCiphertext.sshPtyConsumerRecoveries[0]?.ownerLease }
      ]
    })

    cipherState.decryptionThrows = false
    const restarted = await createStore()
    expect(restarted.getSettings().httpProxyUrl).toBe(ORIGINAL.proxy)
    expect(restarted.getSettings().opencodeSessionCookie).toBe(ORIGINAL.cookie)
    expect(restarted.getUI().browserKagiSessionLink).toBe(ORIGINAL.kagi)
    expect(openOwnerLease(readState().sshPtyConsumerRecoveries[0]?.ownerLease)).toBe(OWNER_LEASE)
  })

  it('accepts validated legacy plaintext for OpenCode and SSH migration', async () => {
    const legacyCookie = 'auth=Fe26.2**legacy-token'
    const legacyOwnerLease = '9ab3f53d-0de9-4b80-af38-0cc15f62a6ba'
    writeFileSync(
      dataFile(),
      JSON.stringify({
        settings: { opencodeSessionCookie: legacyCookie },
        sshPtyConsumerRecoveries: [
          {
            targetId: 'ssh-1',
            clientInstanceId: 'client-1',
            serverBuildId: 'relay-build-1',
            clientGeneration: 1,
            ownerGeneration: 1,
            ownerLease: legacyOwnerLease
          }
        ]
      })
    )

    const store = await createStore()
    expect(store.getSettings().opencodeSessionCookie).toBe(legacyCookie)
    store.updateSettings({ httpProxyBypassRules: 'migrated' })
    await settleSave(store)
    expect(openOwnerLease(readState().sshPtyConsumerRecoveries[0]?.ownerLease)).toBe(
      legacyOwnerLease
    )
  })

  it.each<FailureMode>(['availability-throws', 'encryption-throws', 'unavailable'])(
    'saves non-secrets without exposing or destroying protected values: %s',
    async (failureMode) => {
      seedRelayEraRecovery()
      const store = await createStore()
      await writeProtectedState(store, ORIGINAL, 'before')
      const originalCiphertext = readState()
      expectPlaintextsAbsent(readPersistedStateJson(dataFile()), ORIGINAL)
      expect.soft(readPersistedStateJson(dataFile())).not.toContain(OWNER_LEASE)

      vi.advanceTimersByTime(60 * 60 * 1_000 + 1)
      setFailure(failureMode)
      await writeProtectedState(store, PENDING, 'during-failure')

      const primaryRaw = readPersistedStateJson(dataFile())
      const backupRaw = store.prepareProfileStateExport().json
      const persisted = readState()
      expectPlaintextsAbsent(primaryRaw, PENDING)
      expectPlaintextsAbsent(backupRaw, PENDING)
      expect.soft(persisted.settings.httpProxyUrl).toBe(originalCiphertext.settings.httpProxyUrl)
      expect
        .soft(persisted.settings.opencodeSessionCookie)
        .toBe(originalCiphertext.settings.opencodeSessionCookie)
      expect
        .soft(persisted.ui.browserKagiSessionLink)
        .toBe(originalCiphertext.ui.browserKagiSessionLink)
      expect
        .soft(persisted.sshPtyConsumerRecoveries[0]?.ownerLease)
        .toBe(originalCiphertext.sshPtyConsumerRecoveries[0]?.ownerLease)
      expect.soft(persisted.settings.httpProxyBypassRules).toBe('during-failure')

      const loadedDuringFailure = await createStore()
      expect(loadedDuringFailure.getSettings().httpProxyBypassRules).toBe('during-failure')
      await settleSave(loadedDuringFailure)
      expectPlaintextsAbsent(readPersistedStateJson(dataFile()), PENDING)

      cipherState.availability = 'available'
      cipherState.encryptionThrows = false
      const recovered = await createStore()
      expect(recovered.getSettings().httpProxyUrl).toBe(ORIGINAL.proxy)
      expect(recovered.getSettings().opencodeSessionCookie).toBe(ORIGINAL.cookie)
      expect(recovered.getUI().browserKagiSessionLink).toBe(ORIGINAL.kagi)
      expect(recovered.getSettings().httpProxyBypassRules).toBe('during-failure')

      await writeProtectedState(recovered, PENDING, 'recovered')
      const restarted = await createStore()
      expect(restarted.getSettings().httpProxyUrl).toBe(PENDING.proxy)
      expect(restarted.getSettings().opencodeSessionCookie).toBe(PENDING.cookie)
      expect(restarted.getUI().browserKagiSessionLink).toBe(PENDING.kagi)
      expect(restarted.getSettings().httpProxyBypassRules).toBe('recovered')
      expect(openOwnerLease(readState().sshPtyConsumerRecoveries[0]?.ownerLease)).toBe(OWNER_LEASE)
    }
  )
})
