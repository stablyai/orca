import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeSqlite from 'node:sqlite'
import type * as ChromiumCookieSnapshotModule from './chromium-cookie-snapshot'
import type { DetectedBrowser } from './browser-cookie-detection-types'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const {
  appGetPathMock,
  sessionFromPartitionMock,
  runProcessSyncMock,
  snapshotRootMock,
  setPendingCookieImportMock,
  clearPendingCookieImportMock,
  writeCookieIdentityMock,
  openedDatabases,
  cleanupStates
} = vi.hoisted(() => {
  const openedDatabases: { path: string; database: NodeSqlite.DatabaseSync }[] = []
  const cleanupStates: boolean[][] = []
  return {
    appGetPathMock: vi.fn(),
    sessionFromPartitionMock: vi.fn(),
    runProcessSyncMock: vi.fn(),
    snapshotRootMock: vi.fn(),
    setPendingCookieImportMock: vi.fn(),
    clearPendingCookieImportMock: vi.fn(),
    writeCookieIdentityMock: vi.fn(),
    openedDatabases,
    cleanupStates
  }
})

vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  session: { fromPartition: sessionFromPartitionMock }
}))
vi.mock('@orca/process-host', () => ({
  runProcessSync: runProcessSyncMock
}))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: setPendingCookieImportMock,
    clearPendingCookieImport: clearPendingCookieImportMock
  }
}))
vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeSqlite>()
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
        super(...args)
        openedDatabases.push({ path: String(args[0]), database: this })
      }
    }
  }
})
vi.mock('./chromium-cookie-snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof ChromiumCookieSnapshotModule>()
  return {
    ...actual,
    createChromiumCookieSnapshot: (sourcePath: string) => {
      const snapshot = actual.createChromiumCookieSnapshot(sourcePath, {
        tempRoot: snapshotRootMock()
      })
      return {
        ...snapshot,
        cleanup: () => {
          cleanupStates.push(
            openedDatabases
              .filter(
                ({ path }) =>
                  path === snapshot.databasePath || path.includes('cookie-import-staging')
              )
              .map(({ database }) => database.isOpen)
          )
          snapshot.cleanup()
        }
      }
    }
  }
})
vi.mock('./browser-cookie-clear-store', () => ({
  openCookieClearStore: (targetSession: {
    cookies: { get: () => Promise<unknown>; remove: (url: string, name: string) => Promise<void> }
  }) => ({
    get: () => targetSession.cookies.get(),
    remove: (url: string, name: string) => targetSession.cookies.remove(url, name),
    snapshotClearIdentities: async () => [],
    restoreClearIdentities: async () => undefined,
    writeCookieIdentity: writeCookieIdentityMock,
    dispose: () => undefined
  })
}))

import { importChromiumCookies } from './browser-cookie-chromium-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { DatabaseSync } from 'node:sqlite'

const PARTITION = 'persist:test'

function chromeBrowser(cookiesPath: string): DetectedBrowser {
  return {
    family: 'chrome',
    label: 'Google Chrome',
    cookiesPath,
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }
}

describe('Chromium import snapshot ownership', () => {
  let root: string
  let sourcePath: string
  let targetPath: string
  let snapshotRoot: string
  let stagingRoot: string
  let sourceDatabase: NodeSqlite.DatabaseSync
  let targetBefore: Buffer
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let platformSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-cookie-snapshot-owner-test-'))
    snapshotRoot = root
    sourcePath = join(root, 'Chrome', 'Default', 'Network', 'Cookies')
    targetPath = join(root, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    stagingRoot = join(root, 'userData', 'cookie-import-staging')
    sourceDatabase = createChromiumCookieTestDatabase(sourcePath, [], { journalMode: 'wal' })
    createChromiumCookieTestDatabase(targetPath, [
      { domain: '.other.test', name: 'old', value: 'target' }
    ]).close()
    targetBefore = readFileSync(targetPath)
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    appGetPathMock.mockReturnValue(join(root, 'userData'))
    snapshotRootMock.mockReturnValue(snapshotRoot)
    sessionFromPartitionMock.mockReturnValue({
      getStoragePath: () => dirname(dirname(targetPath)),
      cookies: {
        flushStore: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue([]),
        remove: cookiesRemoveMock,
        set: vi.fn().mockRejectedValue(new Error('Unexpected target initialization'))
      }
    })
    runProcessSyncMock.mockReturnValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    writeCookieIdentityMock.mockResolvedValue(undefined)
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    cleanupStates.length = 0
  })

  afterEach(() => {
    for (const { database } of openedDatabases) {
      if (database.isOpen) {
        database.close()
      }
    }
    openedDatabases.length = 0
    platformSpy.mockRestore()
    vi.clearAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  function snapshotDirectories() {
    return readdirSync(snapshotRoot).filter((name) => name.startsWith('orca-cookie-import-'))
  }

  function expectRefusalCleanup() {
    expect(snapshotDirectories()).toEqual([])
    expect(readdirSync(stagingRoot)).toEqual([])
    expect(readFileSync(targetPath)).toEqual(targetBefore)
    expect(writeCookieIdentityMock).not.toHaveBeenCalled()
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(setPendingCookieImportMock).not.toHaveBeenCalled()
    expect(cleanupStates.every((states) => states.every((open) => !open))).toBe(true)
  }

  function insertSourceCookie(encrypted: boolean) {
    sourceDatabase.exec(`INSERT INTO cookies (
      creation_utc, host_key, name, value, encrypted_value, path, expires_utc,
      is_secure, is_httponly, samesite
    ) VALUES (133000000000000, '.example.test', 'sid',
      ${encrypted ? "''" : "'source-value'"},
      ${encrypted ? "X'763130656E63727970746564'" : "X''"}, '/', 0, 0, 0, -1)`)
  }

  it('retires an empty live-WAL source snapshot before returning its existing refusal', async () => {
    expect(existsSync(`${sourcePath}-wal`)).toBe(true)
    expect(await importChromiumCookies(chromeBrowser(sourcePath), PARTITION)).toEqual({
      ok: false,
      reason: 'No cookies found in Google Chrome.'
    })
    expect(cleanupStates).toHaveLength(1)
    expectRefusalCleanup()
  })

  it('retires every snapshot when denied credential access is retried', async () => {
    insertSourceCookie(true)
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await importChromiumCookies(chromeBrowser(sourcePath), PARTITION)).toEqual({
        ok: false,
        reason: 'Could not access Google Chrome encryption key. The OS may have denied access.'
      })
      expectRefusalCleanup()
    }
    expect(runProcessSyncMock).toHaveBeenCalledTimes(3)
    expect(cleanupStates).toHaveLength(3)
  })

  it('retires the snapshot when an unreadable partition has no preservable family', async () => {
    insertSourceCookie(false)
    sourceDatabase.exec(
      "UPDATE cookies SET host_key = 'com', top_frame_site_key = 'https://top.test', has_cross_site_ancestor = 2"
    )
    expect(await importChromiumCookies(chromeBrowser(sourcePath), PARTITION)).toEqual({
      ok: false,
      reason:
        'Could not import: a cookie with an unreadable site partition has no registrable domain, so its existing session cannot be protected.'
    })
    expect(cleanupStates).toHaveLength(1)
    expectRefusalCleanup()
  })

  it('closes private databases before cleanup when source schema preparation throws', async () => {
    sourceDatabase.exec('DROP TABLE cookies; CREATE TABLE other_data(value TEXT)')
    expect(await importChromiumCookies(chromeBrowser(sourcePath), PARTITION)).toEqual({
      ok: false,
      reason: expect.stringContaining('no such table: cookies')
    })
    expect(cleanupStates).toHaveLength(1)
    expect(cleanupStates[0].length).toBeGreaterThanOrEqual(2)
    expectRefusalCleanup()
  })

  it('hands successful preparation to the importer for ordinary completion cleanup', async () => {
    insertSourceCookie(false)
    const result = await importChromiumCookies(chromeBrowser(sourcePath), PARTITION)
    expect(result).toMatchObject({ ok: true, summary: { totalCookies: 1, importedCookies: 1 } })
    expect(writeCookieIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sid', value: 'source-value' })
    )
    expect(snapshotDirectories()).toEqual([])
    expect(readdirSync(stagingRoot)).toEqual([])
    expect(cleanupStates).toEqual([[false, false]])
  })

  it('removes the source snapshot while preserving a usable stage owned by restart replay', async () => {
    insertSourceCookie(false)
    writeCookieIdentityMock.mockRejectedValue(new Error('Cookie rejected'))
    expect(await importChromiumCookies(chromeBrowser(sourcePath), PARTITION)).toMatchObject({
      ok: true
    })
    expect(snapshotDirectories()).toEqual([])
    expect(cleanupStates).toEqual([[false, false]])
    expect(setPendingCookieImportMock).toHaveBeenCalledTimes(1)
    const stagedPath: unknown = setPendingCookieImportMock.mock.calls[0][1]
    if (typeof stagedPath !== 'string') {
      throw new Error('No staged replay path')
    }
    expect(readdirSync(stagingRoot)).toEqual([basename(stagedPath)])
    const stage = new DatabaseSync(stagedPath, { readOnly: true })
    try {
      const row = stage
        .prepare("SELECT CAST(value AS TEXT) AS value FROM cookies WHERE name = 'sid'")
        .get()
      expect(row).toEqual({ value: 'source-value' })
    } finally {
      stage.close()
    }
  })
})
