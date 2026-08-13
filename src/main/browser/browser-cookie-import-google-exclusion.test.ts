/**
 * STA-3811: an import must never write and never remove a google.com-family cookie, on any
 * path. Removing 'google.com' from NON_TRANSPLANTABLE_DOMAINS flips every test here red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appGetPathMock,
  clearPendingCookieImportMock,
  execFileSyncMock,
  sessionFromPartitionMock,
  setPendingCookieImportMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  setPendingCookieImportMock: vi.fn()
}))

vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: setPendingCookieImportMock,
    clearPendingCookieImport: clearPendingCookieImportMock
  }
}))
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))
vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  dialog: { showOpenDialog: vi.fn() },
  session: { fromPartition: sessionFromPartitionMock }
}))

import { importCookiesFromBrowser, importCookiesFromFile } from './browser-cookie-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function existingCookie(domain: string, name: string) {
  return { domain, name, path: '/', secure: true, sameSite: 'unspecified', value: 'live' }
}

const INCOMING = [
  { domain: '.google.com', name: 'SAPISID', value: 'transplanted', secure: true },
  { domain: 'accounts.google.com', name: '__Secure-1PSID', value: 'transplanted', secure: true },
  { domain: '.youtube.com', name: 'LOGIN_INFO', value: 'transplanted', secure: true },
  { domain: '.linear.app', name: 'session', value: 'new', secure: true }
]

describe('file import excludes the Google cookie family', () => {
  let cookiesGetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-google-exclusion-file-'))
    cookiesGetMock = vi.fn().mockResolvedValue([])
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReturnValue({
      cookies: { get: cookiesGetMock, remove: cookiesRemoveMock, set: cookiesSetMock }
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeCookies(cookies: unknown[]): string {
    const filePath = join(tmpDir, 'cookies.json')
    writeFileSync(filePath, JSON.stringify(cookies))
    return filePath
  }

  it('writes no Google cookie and removes none, whatever is already in the jar', async () => {
    cookiesGetMock.mockResolvedValue([
      existingCookie('.google.com', 'SID'),
      existingCookie('accounts.google.com', '__Secure-1PSID'),
      existingCookie('.linear.app', 'old-linear')
    ])

    const result = await importCookiesFromFile(writeCookies(INCOMING), 'persist:test')

    expect(result.ok && result.summary).toMatchObject({
      totalCookies: 4,
      importedCookies: 2,
      skippedCookies: 2,
      googleCookiesSkipped: 2,
      domains: ['linear.app', 'youtube.com']
    })
    expect(cookiesRemoveMock.mock.calls).toEqual([['https://linear.app/', 'old-linear']])
    expect(cookiesSetMock.mock.calls.map(([details]) => details.domain)).toEqual([
      '.youtube.com',
      '.linear.app'
    ])
  })

  it('leaves Google cookies from an older import in place too', async () => {
    cookiesGetMock.mockResolvedValue([existingCookie('.google.com', 'SAPISID')])

    const result = await importCookiesFromFile(
      writeCookies([{ domain: '.google.com', name: 'SAPISID', value: 'newer', secure: true }]),
      'persist:test'
    )

    expect(result.ok && result.summary).toMatchObject({
      totalCookies: 1,
      importedCookies: 0,
      skippedCookies: 1,
      googleCookiesSkipped: 1,
      domains: []
    })
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })
})

describe('native Chromium import excludes the Google cookie family', () => {
  let clearDataMock: ReturnType<typeof vi.fn>
  let cookiesGetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let tmpDir: string
  let platformSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-google-exclusion-native-'))
    appGetPathMock.mockReturnValue(join(tmpDir, 'userData'))
    execFileSyncMock.mockImplementation(() => {
      throw new Error('OS browser version lookup unavailable')
    })
    clearDataMock = vi.fn().mockResolvedValue(undefined)
    cookiesGetMock = vi.fn().mockResolvedValue([])
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        flushStore: vi.fn().mockResolvedValue(undefined),
        get: cookiesGetMock,
        remove: cookiesRemoveMock,
        set: cookiesSetMock
      },
      clearData: clearDataMock
    })
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  })

  afterEach(() => {
    platformSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedSource(rows: { domain: string; name: string; value: string }[]): string {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, rows).close()
    return sourceCookiesPath
  }

  function seedTarget(rows: { domain: string; name: string; value: string }[]): void {
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(targetCookiesPath, rows).close()
  }

  it('bulk clears while excluding live Google cookies before importing', async () => {
    const sourceCookiesPath = seedSource([
      { domain: '.google.com', name: 'SID', value: 'transplanted-sid' },
      { domain: '.example.com', name: 'session', value: 'new' }
    ])
    seedTarget([{ domain: '.google.com', name: 'SID', value: 'live-sid' }])
    cookiesGetMock.mockResolvedValue([
      existingCookie('.google.com', 'SID'),
      existingCookie('.example.com', 'stale')
    ])

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok && result.summary).toMatchObject({
      totalCookies: 2,
      importedCookies: 1,
      skippedCookies: 1,
      googleCookiesSkipped: 1,
      domains: ['example.com']
    })
    expect(clearDataMock.mock.calls).toEqual([
      [{ dataTypes: ['cookies'], excludeOrigins: ['https://google.com'] }]
    ])
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(cookiesSetMock.mock.calls.map(([details]) => details.domain)).toEqual(['.example.com'])
  })

  it('reports an excluded Google row even when its encrypted value is invalid', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      {
        domain: '.google.com',
        name: 'SID',
        value: '',
        encryptedValue: Buffer.from('v10-invalid')
      },
      { domain: '.example.com', name: 'session', value: 'new' }
    ]).close()
    seedTarget([])

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok && result.summary).toMatchObject({
      totalCookies: 2,
      importedCookies: 1,
      skippedCookies: 1,
      googleCookiesSkipped: 1
    })
    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(cookiesSetMock.mock.calls.map(([details]) => details.name)).toEqual(['session'])
  })

  it('does not request an encryption key for excluded Google rows', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      {
        domain: '.google.com',
        name: 'SID',
        value: '',
        encryptedValue: Buffer.from('v10-invalid')
      }
    ]).close()
    seedTarget([])

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok && result.summary).toEqual({
      totalCookies: 1,
      importedCookies: 0,
      skippedCookies: 1,
      googleCookiesSkipped: 1,
      domains: []
    })
    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(clearDataMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  it('keeps the live Google rows in the staged restart-fallback database', async () => {
    const sourceCookiesPath = seedSource([
      { domain: '.google.com', name: 'SID', value: 'transplanted-sid' },
      { domain: '.example.com', name: 'session', value: 'new' }
    ])
    seedTarget([
      { domain: '.google.com', name: 'SID', value: 'live-sid' },
      { domain: '.example.com', name: 'stale', value: 'stale' }
    ])
    // Why: a rejected set() forces the staged DB to be kept for cold-restart replay.
    cookiesSetMock.mockRejectedValue(new Error('cookie rejected'))

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    expect(setPendingCookieImportMock).toHaveBeenCalledTimes(1)
    const [partition, stagedPath] = setPendingCookieImportMock.mock.calls[0]
    expect(partition).toBe('persist:test')
    expect(readStagedRows(stagedPath)).toEqual([
      { host_key: '.example.com', name: 'session', value: 'new' },
      { host_key: '.google.com', name: 'SID', value: 'live-sid' }
    ])
  })

  // Why (STA-4061): reconstruction drops partition keys, so a rejected removal must not rebuild
  // anything — not the excluded Google rows, and not the non-Google rows that were already gone.
  it('fails the import without reconstructing any cookie when selective removal rejects', async () => {
    const sourceCookiesPath = seedSource([
      { domain: '.example.com', name: 'session', value: 'new' }
    ])
    seedTarget([{ domain: '.example.com', name: 'stale', value: 'stale' }])
    cookiesGetMock.mockResolvedValue([
      existingCookie('.google.com', 'SID'),
      existingCookie('.example.com', 'removed-first'),
      existingCookie('.other.test', 'stale')
    ])
    cookiesRemoveMock.mockImplementation(async (_url: string, name: string) => {
      if (name === 'stale') {
        throw new Error('cookie store unavailable')
      }
    })
    clearDataMock.mockRejectedValue(new Error('storage busy'))

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result).toMatchObject({ ok: false })
    expect(result.ok || result.reason).toContain('Could not clear existing cookies')
    expect(clearDataMock).toHaveBeenCalledOnce()
    expect(cookiesRemoveMock.mock.calls.map(([, name]) => name)).toEqual(['removed-first', 'stale'])
    expect(cookiesSetMock).not.toHaveBeenCalled()
    expect(setPendingCookieImportMock).not.toHaveBeenCalled()
  })
})

// Why: freshly imported rows store the decrypted value as a BLOB; read both forms as text.
function readStagedRows(stagedPath: string): { host_key: string; name: string; value: string }[] {
  const stagedDb = new DatabaseSync(stagedPath, { readOnly: true })
  const rows = stagedDb
    .prepare('SELECT host_key, name, value FROM cookies ORDER BY host_key, name')
    .all() as { host_key: string; name: string; value: string | Uint8Array }[]
  stagedDb.close()
  return rows.map((row) => ({
    ...row,
    value: typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('latin1')
  }))
}

function chromeBrowser(cookiesPath: string) {
  return {
    family: 'chrome' as const,
    label: 'Google Chrome',
    cookiesPath,
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }
}
