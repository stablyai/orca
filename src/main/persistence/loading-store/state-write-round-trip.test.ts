/**
 * The write path now hands the file a Buffer it built in one pass instead of a string it rebuilt
 * per secret. Drives the real `Store` end to end — encrypted settings, a local session and a remote
 * host partition — and reloads from the file it actually wrote, because the failure this guards
 * against (a mis-sliced segment, a re-encoded payload, a dropped sentinel) is invisible until
 * something reads the bytes back.
 */
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
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
