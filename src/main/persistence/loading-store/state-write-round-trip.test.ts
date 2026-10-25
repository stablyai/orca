import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson,
  writePersistedStateJson
} from '../persistence-test-harness'
// Verify persisted UTF-8 bytes round-trip through secrets, local sessions and remote partitions.
import { getSecretStore } from '../../../shared/secret-store'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

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

const { Store } = await import('./store')

const HOST_ID = 'ssh:user@host'

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

function session(activeTabId: string): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    // Left null: the load path's deregistered-repo sweep nulls an active worktree whose repo is
    // not registered, which would mask what this test is actually about.
    activeWorktreeId: null,
    activeTabId,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    // Non-ASCII on purpose: a byte-offset mistake in the encode shows up here first.
    browserUrlHistory: [
      {
        url: 'https://example.test/é😀',
        normalizedUrl: 'https://example.test/é😀',
        title: '中文 title',
        lastVisitedAt: 17,
        visitCount: 3
      }
    ]
  } as WorkspaceSessionState
}

describe('persisted state survives a save/load round trip', () => {
  it.each(['split-vertical', 'split-horizontal', 'new-tab'])(
    'drops retired setup location %s on update and disk serialization',
    (setupScriptLaunchMode) => {
      const dataFile = join(
        realpathSync(mkdtempSync(join(tmpdir(), 'orca-retired-setup-location-'))),
        'state.json'
      )
      const written = openStore(dataFile)
      const updates = { setupScriptLaunchMode, terminalFocusFollowsMouse: true }
      expect(written.updateSettings(updates)).not.toHaveProperty('setupScriptLaunchMode')
      written.flush()
      const saved = JSON.parse(readPersistedStateJson(dataFile))
      expect(saved.settings).not.toHaveProperty('setupScriptLaunchMode')
      const loaded = openStore(dataFile).getSettings()
      expect(loaded).not.toHaveProperty('setupScriptLaunchMode')
      expect(loaded.terminalFocusFollowsMouse).toBe(true)
    }
  )

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

  it('reloads settings, secrets and both session partitions unchanged', () => {
    const dataFile = join(
      realpathSync(mkdtempSync(join(tmpdir(), 'orca-store-round-trip-'))),
      'orca-data.json'
    )
    const written = openStore(dataFile)
    written.updateSettings({
      opencodeSessionCookie: 'cookie-é-value',
      httpProxyUrl: 'http://proxy.example:8080/?a=b&c=$&'
    })
    written.updateUI({ browserKagiSessionLink: 'https://kagi.com/session?t=abc' })
    written.setWorkspaceSession(session('local-tab'))
    written.setWorkspaceSession(session('remote-tab'), HOST_ID)
    written.flush()

    const before = {
      settings: written.getSettings(),
      ui: written.getUI(),
      local: written.getWorkspaceSession(),
      remote: written.getWorkspaceSession(HOST_ID)
    }

    const bytes = Buffer.from(readPersistedStateJson(dataFile))
    const onDisk = JSON.parse(bytes.toString('utf8'))
    expect(onDisk.settings.opencodeSessionCookie).not.toBe('cookie-é-value')
    expect(Buffer.from(onDisk.settings.opencodeSessionCookie, 'base64').toString('utf8')).toContain(
      'cookie-é-value'
    )
    expect(bytes.toString('utf8')).not.toContain('orca-secret-slot-')

    const reloaded = openStore(dataFile)
    expect(reloaded.getSettings().opencodeSessionCookie).toBe(before.settings.opencodeSessionCookie)
    expect(reloaded.getSettings().httpProxyUrl).toBe(before.settings.httpProxyUrl)
    expect(reloaded.getUI().browserKagiSessionLink).toBe(before.ui.browserKagiSessionLink)
    // Loading adds session defaults; assert exact equality after the second round trip.
    expect(reloaded.getWorkspaceSession()).toMatchObject(before.local)
    // Remote partitions omit local-owned globals and reload their default values.
    expect(reloaded.getWorkspaceSession(HOST_ID).activeTabId).toBe('remote-tab')
    expect(reloaded.getWorkspaceSession(HOST_ID).browserUrlHistory).toEqual([])

    // Compare after a second round trip so one-time migrations cannot affect equality.
    reloaded.flush()
    const bytesAfterReload = Buffer.from(readPersistedStateJson(dataFile))
    const again = openStore(dataFile)
    expect(again.getSettings()).toEqual(reloaded.getSettings())
    expect(again.getUI()).toEqual(reloaded.getUI())
    expect(again.getWorkspaceSession()).toEqual(reloaded.getWorkspaceSession())
    expect(again.getWorkspaceSession(HOST_ID)).toEqual(reloaded.getWorkspaceSession(HOST_ID))
    again.flush()
    expect(Buffer.from(readPersistedStateJson(dataFile)).equals(bytesAfterReload)).toBe(true)
  })
})
