import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeSqlite from 'node:sqlite'
import type * as ChromiumCookieSnapshotModule from '../chromium-cookie-snapshot'
import type { DetectedBrowser } from './sources/browser-cookie-detection-types'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const {
  appGetPathMock,
  sessionFromPartitionMock,
  runProcessMock,
  snapshotRootMock,
  setPendingCookieImportMock,
  clearPendingCookieImportMock,
  writeCookieIdentityMock,
  openedDatabases,
  cleanupStates,
  snapshotPopulations
} = vi.hoisted(() => {
  const openedDatabases: { path: string; database: NodeSqlite.DatabaseSync }[] = []
  const cleanupStates: boolean[][] = []
  const snapshotPopulations: number[] = []
  return {
    appGetPathMock: vi.fn(),
    sessionFromPartitionMock: vi.fn(),
    runProcessMock: vi.fn(),
    snapshotRootMock: vi.fn(),
    setPendingCookieImportMock: vi.fn(),
    clearPendingCookieImportMock: vi.fn(),
    writeCookieIdentityMock: vi.fn(),
    openedDatabases,
    cleanupStates,
    snapshotPopulations
  }
})

vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  session: { fromPartition: sessionFromPartitionMock }
}))
vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock
}))
vi.mock('../browser-session-registry', () => ({
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
vi.mock('../chromium-cookie-snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof ChromiumCookieSnapshotModule>()
  return {
    ...actual,
    createChromiumCookieSnapshot: (sourcePath: string) => {
      const tempRoot = snapshotRootMock()
      const snapshot = actual.createChromiumCookieSnapshot(sourcePath, { tempRoot })
      snapshotPopulations.push(
        readdirSync(tempRoot).filter((name) => name.startsWith('orca-cookie-import-')).length
      )
      return {
        ...snapshot,
        cleanup: () => {
          cleanupStates.push(
            openedDatabases
              .filter(({ path }) => path === snapshot.databasePath)
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

import { importChromiumCookies } from './chromium/import-cookies'
import {
  createChromiumCookieTestDatabase,
  encryptMacChromiumCookie
} from './browser-cookie-import-test-database'
import { acquireCookieMutationLock } from './browser-cookie-import-clear'
import * as cookieDecryption from './sources/browser-cookie-decryption'

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
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    writeCookieIdentityMock.mockResolvedValue(undefined)
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    cleanupStates.length = 0
    snapshotPopulations.length = 0
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
    expect(existsSync(stagingRoot)).toBe(false)
    expect(readFileSync(targetPath)).toEqual(targetBefore)
    expect(writeCookieIdentityMock).not.toHaveBeenCalled()
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(setPendingCookieImportMock).not.toHaveBeenCalled()
    expect(clearPendingCookieImportMock).not.toHaveBeenCalled()
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
    expect(runProcessMock).toHaveBeenCalledTimes(3)
    expect(cleanupStates).toHaveLength(3)
  })

  it('retires the snapshot after skipping an unreadable partition without a registrable family', async () => {
    insertSourceCookie(false)
    sourceDatabase.exec(
      "UPDATE cookies SET host_key = 'com', top_frame_site_key = 'https://top.test', has_cross_site_ancestor = 2"
    )
    expect(await importChromiumCookies(chromeBrowser(sourcePath), PARTITION)).toMatchObject({
      ok: true,
      summary: { importedCookies: 0, skippedCookies: 1, domains: [] }
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
    expect(cleanupStates[0].length).toBeGreaterThanOrEqual(1)
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
    expect(existsSync(stagingRoot)).toBe(false)
    expect(cleanupStates).toEqual([[false]])
  })

  it('removes the source snapshot after a live rejection without creating replay data', async () => {
    insertSourceCookie(false)
    writeCookieIdentityMock.mockRejectedValue(new Error('Cookie rejected'))
    expect(await importChromiumCookies(chromeBrowser(sourcePath), PARTITION)).toMatchObject({
      ok: true,
      summary: { importedCookies: 0, skippedCookies: 1 }
    })
    expect(snapshotDirectories()).toEqual([])
    expect(cleanupStates).toEqual([[false]])
    expect(setPendingCookieImportMock).not.toHaveBeenCalled()
    expect(clearPendingCookieImportMock).toHaveBeenCalledExactlyOnceWith(PARTITION)
    expect(existsSync(stagingRoot)).toBe(false)
  })

  it.each([2, 20])(
    'defers snapshot, SQLite read and decryption for %i queued same-Session imports',
    async (requests) => {
      const rows = 200
      const password = 'synthetic-queue-password'
      const encrypted = encryptMacChromiumCookie('v'.repeat(1024), password)
      const insert = sourceDatabase.prepare(`INSERT INTO cookies (
      creation_utc, host_key, name, value, encrypted_value, path, expires_utc,
      is_secure, is_httponly, samesite
    ) VALUES (133000000000000, '.example.test', ?, '', ?, '/', 0, 1, 0, -1)`)
      for (let index = 0; index < rows; index++) {
        insert.run(`cookie${index}`, encrypted)
      }
      runProcessMock.mockResolvedValue({
        code: 0,
        signal: null,
        stdout: password,
        stderr: '',
        timedOut: false
      })
      const decrypt = vi.spyOn(cookieDecryption, 'decryptCookieValueRaw')
      const targetSession = sessionFromPartitionMock()
      const releaseAdmission = await acquireCookieMutationLock(targetSession)
      let releaseWrite!: () => void
      const writing = new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
      let reachedWrite!: () => void
      const firstWrite = new Promise<void>((resolve) => {
        reachedWrite = resolve
      })
      writeCookieIdentityMock.mockImplementation(async () => {
        reachedWrite()
        await writing
      })
      const databasesBefore = openedDatabases.length
      const pending = Array.from({ length: requests }, () =>
        importChromiumCookies(chromeBrowser(sourcePath), PARTITION)
      )
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(snapshotRootMock).not.toHaveBeenCalled()
        expect(snapshotDirectories()).toEqual([])
        expect(openedDatabases).toHaveLength(databasesBefore)
        expect(runProcessMock).not.toHaveBeenCalled()
        expect(decrypt).not.toHaveBeenCalled()
        expect(writeCookieIdentityMock).not.toHaveBeenCalled()

        releaseAdmission()
        await firstWrite
        expect(snapshotDirectories()).toHaveLength(1)
        expect(snapshotRootMock).toHaveBeenCalledOnce()
        expect(openedDatabases).toHaveLength(databasesBefore + 1)
        expect(decrypt).toHaveBeenCalledTimes(rows)
        releaseWrite()
        const results = await Promise.all(pending)
        expect(
          results.every((result) => result.ok && result.summary.importedCookies === rows)
        ).toBe(true)
        expect(snapshotRootMock).toHaveBeenCalledTimes(requests)
        expect(decrypt).toHaveBeenCalledTimes(requests * rows)
        expect(writeCookieIdentityMock).toHaveBeenCalledTimes(requests * rows)
        expect(snapshotPopulations).toEqual(Array(requests).fill(1))
        expect(snapshotDirectories()).toEqual([])
        expect(cleanupStates).toHaveLength(requests)
        expect(cleanupStates.every((states) => states.every((open) => !open))).toBe(true)
      } finally {
        releaseAdmission()
        releaseWrite()
        await Promise.all(pending)
        decrypt.mockRestore()
      }
    }
  )

  it('cleans the snapshot and admits the next import while an earlier flush remains pending', async () => {
    insertSourceCookie(false)
    let releaseFlush!: () => void
    const flushing = new Promise<void>((resolve) => {
      releaseFlush = resolve
    })
    let reachedFlush!: () => void
    const firstFlush = new Promise<void>((resolve) => {
      reachedFlush = resolve
    })
    const targetSession = sessionFromPartitionMock()
    targetSession.cookies.flushStore.mockImplementationOnce(async () => {
      expect(clearPendingCookieImportMock).toHaveBeenCalledExactlyOnceWith(PARTITION)
      reachedFlush()
      await flushing
    })
    const first = importChromiumCookies(chromeBrowser(sourcePath), PARTITION)
    try {
      await firstFlush
      expect(snapshotDirectories()).toEqual([])
      expect(await importChromiumCookies(chromeBrowser(sourcePath), PARTITION)).toMatchObject({
        ok: true,
        summary: { importedCookies: 1 }
      })
      expect(writeCookieIdentityMock).toHaveBeenCalledTimes(2)
      expect(snapshotPopulations).toEqual([1, 1])
      expect(snapshotDirectories()).toEqual([])
    } finally {
      releaseFlush()
      await first
    }
  })
})
