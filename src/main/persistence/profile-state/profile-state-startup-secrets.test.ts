import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSecretStore,
  hasSecretStore,
  setSecretStore,
  _resetSecretStoreForTests
} from '../../../shared/secret-store'
import { Store } from '../loading-store/store'
import * as storeDomains from '../loading-store/store-domain-composition'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'

let keyState: 'available' | 'unavailable' | 'decrypt-fails' = 'available'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../telemetry/client', () => ({ track: () => {} }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

let originalSecretStore: ReturnType<typeof getSecretStore> | undefined
beforeEach(() => {
  originalSecretStore = hasSecretStore() ? getSecretStore() : undefined
  setSecretStore({
    isEncryptionAvailable: () => keyState !== 'unavailable',
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => {
      if (keyState === 'decrypt-fails') {
        throw new Error('keychain denied decryption')
      }
      return value.toString('utf8').slice('encrypted:'.length)
    },
    describeProtectionGap: () => null
  })
})

const directories: string[] = []
const stores: Store[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores) {
    store.freezeWrites()
  }
  for (const store of stores.splice(0)) {
    await store.flushAsync()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  keyState = 'available'
  if (originalSecretStore) {
    setSecretStore(originalSecretStore)
  } else {
    _resetSecretStoreForTests()
  }
})

const secrets = {
  proxy: 'http://user:password@proxy.test:8080',
  cookie: 'startup-secret-cookie',
  kagi: 'https://kagi.com/session?t=startup-secret',
  lease: `startup-owner-lease-${'x'.repeat(480)}`
}
const sealed = (value: string) => Buffer.from(`encrypted:${value}`, 'utf8').toString('base64')

it.each([false, true])(
  'rejects reused input before Store context installation (secret=%s)',
  (hasSecret) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-consumed-startup-'))
    directories.push(directory)
    const authority = new ProfileStateSqliteAuthority(join(directory, 'profile-state.db'), 'once')
    if (hasSecret) {
      authority.writeSerializedState(
        Buffer.from(
          JSON.stringify({
            settings: { opencodeSessionCookie: sealed(secrets.cookie) }
          })
        )
      )
    }
    const options = {
      dataFile: join(directory, 'orca-data.json'),
      profileStateAuthority: authority,
      initialAuthorityState: authority.readInitialState()
    }
    const store = new Store(options)
    stores.push(store)
    if (hasSecret) {
      expect(store.getSettings().opencodeSessionCookie).toBe(secrets.cookie)
    }
    const install = vi.spyOn(storeDomains, 'installStoreDomainContexts')

    expect(() => new Store(options)).toThrow('already been consumed')
    expect(install).not.toHaveBeenCalled()
  }
)

describe.each(['serialized', 'parsed'] as const)(
  '%s startup secret retention',
  (representation) => {
    it.each(['available', 'unavailable', 'decrypt-fails'] as const)(
      'preserves every protected slot through an unrelated save when keys are %s',
      async (failure) => {
        const directory = mkdtempSync(join(tmpdir(), 'orca-startup-secrets-'))
        directories.push(directory)
        const dataFile = join(directory, 'orca-data.json')
        const databaseFile = join(directory, 'profile-state.db')
        function open() {
          const authority = new ProfileStateSqliteAuthority(databaseFile, 'startup-secrets')
          const store = new Store({
            dataFile,
            profileStateAuthority: authority,
            ...(representation === 'parsed'
              ? { initialAuthorityState: authority.readInitialState() }
              : {})
          })
          stores.push(store)
          return { store, authority }
        }

        const seeded = open()
        seeded.store.updateSettings({
          httpProxyUrl: secrets.proxy,
          opencodeSessionCookie: secrets.cookie
        })
        seeded.store.updateUI({ browserKagiSessionLink: secrets.kagi })
        await seeded.store.upsertSshPtyConsumerRecovery({
          targetId: 'ssh-1',
          clientInstanceId: 'client-1',
          serverBuildId: 'server-1',
          clientGeneration: 1,
          ownerGeneration: 1,
          ownerLease: secrets.lease
        })
        await seeded.store.flushAsync()
        seeded.store.freezeWrites()

        keyState = failure
        const reopened = open()
        reopened.store.updateSettings({ terminalFontSize: 19 })
        await reopened.store.flushAsync()
        const persisted = reopened.authority.readSerializedState()
        expect(persisted).toBeDefined()
        for (const value of Object.values(secrets)) {
          expect(persisted).not.toContain(value)
        }
        expect(JSON.parse(persisted ?? 'null')).toMatchObject({
          settings: {
            terminalFontSize: 19,
            httpProxyUrl: sealed(secrets.proxy),
            opencodeSessionCookie: sealed(secrets.cookie)
          },
          ui: { browserKagiSessionLink: sealed(secrets.kagi) },
          sshPtyConsumerRecoveries: [{ ownerLease: sealed(secrets.lease) }]
        })
        reopened.store.freezeWrites()

        keyState = 'available'
        const restored = open().store
        expect(restored.getSettings().httpProxyUrl).toBe(secrets.proxy)
        expect(restored.getSettings().opencodeSessionCookie).toBe(secrets.cookie)
        expect(restored.getUI().browserKagiSessionLink).toBe(secrets.kagi)
        expect(restored.getSshPtyConsumerRecovery('ssh-1')?.ownerLease).toBe(secrets.lease)
      }
    )
  }
)
