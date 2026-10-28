import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CookiesGetFilter } from 'electron'

const {
  appGetPathMock,
  clearPendingCookieImportMock,
  disposeClearStoreMock,
  execFileSyncMock,
  restoreClearIdentitiesMock,
  sessionFromPartitionMock,
  setPendingCookieImportMock,
  snapshotClearIdentitiesMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn(),
  disposeClearStoreMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  restoreClearIdentitiesMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  setPendingCookieImportMock: vi.fn(),
  snapshotClearIdentitiesMock: vi.fn()
}))

vi.mock('../browser-session-registry', () => ({
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
vi.mock('./browser-cookie-clear-store', () => ({
  openCookieClearStore: (targetSession: {
    cookies: {
      get: (filter: CookiesGetFilter) => Promise<unknown>
      remove: (url: string, name: string) => Promise<void>
      set?: (details: Record<string, unknown>) => Promise<void>
    }
  }) => ({
    get: (filter: CookiesGetFilter) => targetSession.cookies.get(filter),
    remove: (url: string, name: string) => targetSession.cookies.remove(url, name),
    // Route CDP writes to the spy so missing-method errors cannot mask the real write path.
    writeCookieIdentity: (identity: Record<string, unknown>) =>
      targetSession.cookies.set!(identity),
    snapshotClearIdentities: snapshotClearIdentitiesMock,
    restoreClearIdentities: restoreClearIdentitiesMock,
    dispose: disposeClearStoreMock
  })
}))

import { importCookiesFromBrowser, importCookiesFromFile } from './browser-cookie-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(() => {
  snapshotClearIdentitiesMock
    .mockReset()
    .mockImplementation(async (items: { cookie: Record<string, unknown>; url: string }[]) =>
      items.map(({ cookie: entry, url }) => ({ url, ...entry }))
    )
  restoreClearIdentitiesMock.mockReset().mockResolvedValue(undefined)
  disposeClearStoreMock.mockReset()
})

describe('validated cookie replacement', () => {
  let cookiesGetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-replacement-test-'))
    cookiesGetMock = vi.fn().mockResolvedValue([])
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset().mockReturnValue({
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

  it('keeps Google out of the replace scope so its cookies are never removed', async () => {
    cookiesGetMock.mockResolvedValue([
      cookie('.google.com', 'old-google'),
      cookie('.accounts.google.com', 'old-accounts', '/signin'),
      cookie('.example.com', 'old-example'),
      cookie('.unrelated.com', 'keep'),
      cookie('.google.com.evil.example', 'keep-suffix-confusion')
    ])
    const filePath = writeCookies([
      { domain: '.google.com', name: 'SIDCC', value: 'source-bound', secure: true },
      { domain: '.google.com', name: 'SAPISID', value: 'google-session', secure: true },
      { domain: '.example.com', name: 'SIDCC', value: 'not-google', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok && result.summary).toMatchObject({
      totalCookies: 3,
      importedCookies: 1,
      skippedCookies: 2,
      googleCookiesSkipped: 2,
      domains: ['example.com']
    })
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(cookiesSetMock.mock.calls.map(([details]) => details.name)).toEqual(['SIDCC'])
  })

  it('does not touch the store when every valid entry is source-bound', async () => {
    const filePath = writeCookies([
      { domain: '.google.com', name: 'AEC', value: 'source-bound', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok && result.summary).toEqual({
      totalCookies: 1,
      importedCookies: 0,
      skippedCookies: 1,
      googleCookiesSkipped: 1,
      domains: []
    })
    expect(cookiesGetMock).not.toHaveBeenCalled()
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  it('rejects URL-shaped domains before replacement can clear their normalized scope', async () => {
    const filePath = writeCookies([
      { domain: 'example.com/path', name: 'session', value: 'new', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result).toEqual({
      ok: false,
      reason: 'No valid cookies found. 1 entries were skipped due to missing or invalid fields.'
    })
    expect(cookiesGetMock).not.toHaveBeenCalled()
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  // Rollback must restore captured CDP identities; Electron’s cookie API drops partition keys.
})

describe('native Chromium integrity-cookie accounting', () => {
  let clearDataMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-accounting-test-'))
    appGetPathMock.mockReset().mockReturnValue(join(tmpDir, 'userData'))
    execFileSyncMock.mockReset().mockImplementation(() => {
      throw new Error('OS browser version lookup unavailable')
    })
    clearPendingCookieImportMock.mockClear()
    setPendingCookieImportMock.mockClear()
    clearDataMock = vi.fn().mockResolvedValue(undefined)
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset().mockReturnValue({
      cookies: {
        flushStore: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue([]),
        remove: vi.fn().mockResolvedValue(undefined),
        set: cookiesSetMock
      },
      clearData: clearDataMock,
      getStoragePath: () => join(tmpDir, 'userData', 'Partitions', 'test')
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('counts every excluded Google cookie in skippedCookies', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { domain: '.google.com', name: 'AEC', value: 'source-bound' },
      { domain: '.google.com', name: 'SAPISID', value: 'google-session' },
      { domain: '.example.com', name: 'AEC', value: 'not-google' }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )
      expect(result.ok && result.summary).toMatchObject({
        totalCookies: 3,
        importedCookies: 1,
        skippedCookies: 2,
        googleCookiesSkipped: 2,
        domains: ['example.com']
      })
      expect(cookiesSetMock.mock.calls.map(([details]) => details.name)).toEqual(['AEC'])
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('preserves the destination when every source cookie is filtered or invalid', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { domain: '.google.com', name: 'AEC', value: 'source-bound' },
      { domain: '.accounts.google.com', name: 'SIDCC', value: 'source-bound' },
      { domain: 'example.com/path', name: 'invalid-domain', value: 'invalid' }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, [
      { domain: '.example.com', name: 'existing', value: 'keep' }
    ]).close()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(result.ok && result.summary).toEqual({
        totalCookies: 3,
        importedCookies: 0,
        skippedCookies: 3,
        googleCookiesSkipped: 2,
        domains: []
      })
      expect(clearDataMock).not.toHaveBeenCalled()
      expect(cookiesSetMock).not.toHaveBeenCalled()
      expect(setPendingCookieImportMock).not.toHaveBeenCalled()
      expect(clearPendingCookieImportMock).not.toHaveBeenCalled()
      expect(existsSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toBe(false)
    } finally {
      platformSpy.mockRestore()
    }
  })
})

function cookie(domain: string, name: string, path = '/') {
  return { domain, name, path, secure: true, sameSite: 'unspecified', value: 'old' }
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
