import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson,
  writePersistedStateJson
} from '../../persistence-test-harness'
// Verify persisted UTF-8 bytes round-trip through secrets, local sessions and remote partitions.
import { getSecretStore } from '../../../../shared/secret-store'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    // Enable encryption so saves exercise secret sentinel substitution.
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => value.toString().slice(4)
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('../store')

const stores: InstanceType<typeof Store>[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  await closeTestStores()
  vi.restoreAllMocks()
})

function openStore(dataFile: string): InstanceType<typeof Store> {
  const store = createSqliteTestStore(Store, { dataFile })
  stores.push(store)
  return store
}

describe('persisted state survives a save/load round trip', () => {
  it('keeps a #22551 settings-slot OpenCode Go key on disk until its new owner has it', () => {
    const dataFile = join(
      realpathSync(mkdtempSync(join(tmpdir(), 'orca-legacy-opencode-go-key-'))),
      'state.json'
    )
    const first = openStore(dataFile)
    first.updateSettings({ opencodeWorkspaceId: 'wrk_test' })
    first.flush()
    const persisted = JSON.parse(readPersistedStateJson(dataFile))
    // Seed the legacy encrypted-secret format.
    const sealed = getSecretStore().encryptString('fake-legacy-key').toString('base64')
    persisted.settings.opencodeGoApiKey = sealed
    writePersistedStateJson(dataFile, JSON.stringify(persisted))
    const onDiskKey = (): unknown =>
      JSON.parse(readPersistedStateJson(dataFile)).settings.opencodeGoApiKey

    // Model a daemon that flushes without running the retired-key migration.
    const daemon = createSqliteTestStore(Store, { dataFile })
    stores.push(daemon)
    expect(daemon.getSettings()).not.toHaveProperty('opencodeGoApiKey')
    daemon.updateSettings({ opencodeWorkspaceId: 'wrk_daemon' })
    daemon.flush()
    expect(onDiskKey()).toBe(sealed)
    expect(readPersistedStateJson(dataFile)).not.toContain('fake-legacy-key')

    const loaded = openStore(dataFile)
    expect(loaded.getSettings().opencodeWorkspaceId).toBe('wrk_daemon')
    expect(loaded.getSettings()).not.toHaveProperty('opencodeGoApiKey')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    loaded.migrateLegacyOpenCodeGoApiKey({
      has: () => false,
      read: () => null,
      save: () => {
        throw new Error('disk full')
      }
    })
    loaded.flush()
    expect(onDiskKey()).toBe(sealed)

    // Older paired clients may still send the retired field.
    const updates = { opencodeGoApiKey: 'fake-remote-key', opencodeWorkspaceId: 'wrk_next' }
    expect(loaded.updateSettings(updates)).not.toHaveProperty('opencodeGoApiKey')
    loaded.flush()
    expect(onDiskKey()).toBe(sealed)

    const saved: string[] = []
    loaded.migrateLegacyOpenCodeGoApiKey({
      has: () => saved.length > 0,
      read: () => saved[0] ?? null,
      save: (key) => saved.push(key)
    })
    loaded.migrateLegacyOpenCodeGoApiKey({
      has: () => saved.length > 0,
      read: () => saved[0] ?? null,
      save: (key) => saved.push(key)
    })
    expect(saved).toEqual(['fake-legacy-key'])
    loaded.flush()
    expect(readPersistedStateJson(dataFile)).not.toContain('opencodeGoApiKey')
    expect(openStore(dataFile).getSettings()).not.toHaveProperty('opencodeGoApiKey')
  })
})
