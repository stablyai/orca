/**
 * The write path now hands the file a Buffer it built in one pass instead of a string it rebuilt
 * per secret. Drives the real `Store` end to end — encrypted settings, a local session and a remote
 * host partition — and reloads from the file it actually wrote, because the failure this guards
 * against (a mis-sliced segment, a re-encoded payload, a dropped sentinel) is invisible until
 * something reads the bytes back.
 */
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getSecretStore } from '../../../shared/secret-store'

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
    // Encryption ON, so the secret slots really do mint sentinels and the substitution pass runs.
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
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.flush()
  }
  vi.restoreAllMocks()
})

function openStore(dataFile: string): InstanceType<typeof Store> {
  const store = new Store({ dataFile })
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
  it('keeps a #22551 settings-slot OpenCode Go key on disk until its new owner has it', () => {
    const dataFile = join(
      realpathSync(mkdtempSync(join(tmpdir(), 'orca-legacy-opencode-go-key-'))),
      'state.json'
    )
    const first = openStore(dataFile)
    first.updateSettings({ opencodeWorkspaceId: 'wrk_test' })
    first.flush()
    const persisted = JSON.parse(readFileSync(dataFile, 'utf8'))
    // Sealed exactly as #22551's protected-secret slot wrote it.
    const sealed = getSecretStore().encryptString('fake-legacy-key').toString('base64')
    persisted.settings.opencodeGoApiKey = sealed
    writeFileSync(dataFile, JSON.stringify(persisted))
    const onDiskKey = (): unknown =>
      JSON.parse(readFileSync(dataFile, 'utf8')).settings.opencodeGoApiKey

    // orcad-style consumer: loads and flushes the profile but never runs the migration.
    const daemon = new Store({ dataFile, storageAuthority: 'runtime' })
    stores.push(daemon)
    expect(daemon.getSettings()).not.toHaveProperty('opencodeGoApiKey')
    daemon.updateSettings({ opencodeWorkspaceId: 'wrk_daemon' })
    daemon.flush()
    expect(onDiskKey()).toBe(sealed)
    expect(readFileSync(dataFile, 'utf8')).not.toContain('fake-legacy-key')

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

    // Why: an older paired client can still send the retired field; it must not be stored.
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
    expect(readFileSync(dataFile, 'utf8')).not.toContain('opencodeGoApiKey')
    expect(openStore(dataFile).getSettings()).not.toHaveProperty('opencodeGoApiKey')
  })

  it('reloads settings, secrets and both session partitions unchanged', () => {
    const dataFile = join(
      realpathSync(mkdtempSync(join(tmpdir(), 'orca-store-round-trip-'))),
      'orca-data.json'
    )
    const written = openStore(dataFile)
    written.updateSettings({
      // Three secret slots, i.e. three sentinels in one save — the case the old loop paid 7 copies for.
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

    // The file is valid UTF-8 JSON and holds ciphertext, not the plaintext secrets.
    const bytes = readFileSync(dataFile)
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
    // `toMatchObject`: the load path spreads session defaults over what was written, so the
    // reloaded slice is a superset. Exact deep equality is asserted on the second trip below.
    expect(reloaded.getWorkspaceSession()).toMatchObject(before.local)
    // The remote partition keeps everything it owns; only globals local already holds are dropped,
    // and `browserUrlHistory` comes back at its default from the same spread as before.
    expect(reloaded.getWorkspaceSession(HOST_ID).activeTabId).toBe('remote-tab')
    expect(reloaded.getWorkspaceSession(HOST_ID).browserUrlHistory).toEqual([])

    // Deep equality of the whole reloaded state, taken across a second round trip so the assertion
    // is not comparing against the first load's one-time settings migrations.
    reloaded.flush()
    const bytesAfterReload = readFileSync(dataFile)
    const again = openStore(dataFile)
    expect(again.getSettings()).toEqual(reloaded.getSettings())
    expect(again.getUI()).toEqual(reloaded.getUI())
    expect(again.getWorkspaceSession()).toEqual(reloaded.getWorkspaceSession())
    expect(again.getWorkspaceSession(HOST_ID)).toEqual(reloaded.getWorkspaceSession(HOST_ID))
    // ...and the bytes are stable, so a quiet app is not rewriting a 4 MB file with new content.
    again.flush()
    expect(readFileSync(dataFile).equals(bytesAfterReload)).toBe(true)
  })
})
