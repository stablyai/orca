import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeCrypto from 'node:crypto'
import type * as NodeFs from 'node:fs'

const {
  appGetPathMock,
  createDecipherivMock,
  execFileSyncMock,
  sessionFromPartitionMock,
  dialogShowOpenDialogMock,
  setPendingCookieImportMock,
  clearPendingCookieImportMock,
  writeCookieIdentityMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  createDecipherivMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  dialogShowOpenDialogMock: vi.fn(),
  setPendingCookieImportMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn(),
  writeCookieIdentityMock: vi.fn()
}))

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof NodeCrypto>()
  createDecipherivMock.mockImplementation(original.createDecipheriv)
  return { ...original, createDecipheriv: createDecipherivMock }
})
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: setPendingCookieImportMock,
    clearPendingCookieImport: clearPendingCookieImportMock
  }
}))
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof NodeFs>()) }))
vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: dialogShowOpenDialogMock },
  session: { fromPartition: sessionFromPartitionMock }
}))
vi.mock('./browser-cookie-clear-store', () => ({
  openCookieClearStore: (targetSession: {
    cookies: {
      get: (filter: object) => Promise<unknown>
      remove: (url: string, name: string) => Promise<void>
    }
  }) => ({
    get: (filter: object) => targetSession.cookies.get(filter),
    remove: (url: string, name: string) => targetSession.cookies.remove(url, name),
    snapshotClearIdentities: async (items: { cookie: Record<string, unknown>; url: string }[]) =>
      items.map(({ cookie, url }) => ({ url, ...cookie })),
    restoreClearIdentities: async () => undefined,
    // Why (STA-4300): imports write through the CDP identity store, not cookies.set. A store double
    // missing this method throws a TypeError the per-cookie catch swallows, routing every write
    // down the rejected path while the suite still looks green.
    writeCookieIdentity: writeCookieIdentityMock,
    dispose: () => undefined
  })
}))

import { importCookiesFromBrowser, type DetectedBrowser } from './browser-cookie-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCipheriv, pbkdf2Sync } from 'node:crypto'

// Why: Linux derives its cookie key with a single PBKDF2 round, unlike the 1003 macOS uses, so
// the shared macOS helper cannot produce a row this code path will decrypt.
function encryptLinuxChromiumCookie(value: string, password: string, prefix: string): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([
    Buffer.from(prefix),
    cipher.update(Buffer.from(value, 'latin1')),
    cipher.final()
  ])
}

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

describe('importCookiesFromBrowser — undecryptable cookies', () => {
  let tmpDir: string
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let clearDataMock: ReturnType<typeof vi.fn>
  let targetJar: Record<string, unknown>[]
  let platformSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-linux-keyring-test-'))
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    targetJar = []
    cookiesRemoveMock = vi.fn(async (_url: string, name: string) => {
      const index = targetJar.findIndex((cookie) => cookie.name === name)
      if (index !== -1) {
        targetJar.splice(index, 1)
      }
    })
    clearDataMock = vi.fn(async () => {
      targetJar.splice(0)
    })
    writeCookieIdentityMock.mockReset().mockResolvedValue(undefined)
    appGetPathMock.mockReturnValue(join(tmpDir, 'userData'))
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: vi.fn(async () => targetJar),
        set: cookiesSetMock,
        remove: cookiesRemoveMock,
        flushStore: vi.fn().mockResolvedValue(undefined)
      },
      clearData: clearDataMock,
      setUserAgent: vi.fn(),
      // Why (STA-4300): the importer derives the partition dir from the session rather than
      // trusting a caller-supplied partition, so the double must expose it.
      getStoragePath: vi.fn().mockReturnValue(join(tmpDir, 'userData', 'Partitions', 'test'))
    })
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    // Why: both secret-tool lookups failing is exactly the keyring-unavailable case.
    execFileSyncMock.mockImplementation(() => {
      throw new Error('secret-tool: no such service')
    })
  })

  afterEach(() => {
    platformSpy.mockRestore()
    vi.clearAllMocks()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedProfile(...encryptedValues: Buffer[]): string {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(
      sourceCookiesPath,
      encryptedValues.map((encryptedValue, index) => ({
        name: `sid-${index}`,
        value: '',
        encryptedValue
      }))
    ).close()
    createChromiumCookieTestDatabase(
      join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies'),
      []
    ).close()
    return sourceCookiesPath
  }

  it('does not attempt v11 CBC decryption without a keyring, even with valid wrong-key padding', async () => {
    const sourceCookiesPath = seedProfile(
      encryptLinuxChromiumCookie('wrong-key-garbage', 'peanuts', 'v11')
    )

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(createDecipherivMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.summary.importedCookies).toBe(0)
    expect(result.summary.warning).toEqual({
      code: 'cookies-undecryptable',
      failedCookies: 1,
      reason: 'linux-keyring-unavailable'
    })
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  it('preserves a populated family when its unreadable partition row cannot decrypt', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const sourceDb = createChromiumCookieTestDatabase(sourceCookiesPath, [
      {
        domain: '.preserved.example',
        name: 'undecryptable',
        value: '',
        encryptedValue: encryptLinuxChromiumCookie('wrong-key-garbage', 'peanuts', 'v11'),
        topFrameSiteKey: 'https://top.example'
      },
      { domain: 'sub.preserved.example', name: 'readable-sibling', value: 'do-not-write' },
      { domain: '.replace.test', name: 'plain', value: 'plain-value' }
    ])
    sourceDb.exec("UPDATE cookies SET has_cross_site_ancestor = 2 WHERE name = 'undecryptable'")
    sourceDb.close()
    createChromiumCookieTestDatabase(
      join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies'),
      []
    ).close()
    targetJar.push({
      name: 'live-session',
      value: 'must-survive',
      domain: '.preserved.example',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction'
    })

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(clearDataMock).not.toHaveBeenCalled()
    expect(cookiesRemoveMock).not.toHaveBeenCalledWith(expect.any(String), 'live-session')
    expect(targetJar).toEqual([expect.objectContaining({ name: 'live-session' })])
    expect(writeCookieIdentityMock).toHaveBeenCalledTimes(1)
    expect(writeCookieIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plain', value: 'plain-value' })
    )
    expect(writeCookieIdentityMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'readable-sibling' })
    )
    expect(result.summary).toMatchObject({
      totalCookies: 3,
      importedCookies: 1,
      skippedCookies: 2,
      partitionSkippedCookies: 2,
      warning: {
        code: 'cookies-undecryptable',
        failedCookies: 1,
        reason: 'linux-keyring-unavailable'
      }
    })
    expect(result.summary.totalCookies).toBe(
      result.summary.importedCookies + result.summary.skippedCookies
    )
  })

  it.each(['v10', 'v99'])(
    'rejects a prefix-only %s CBC row before importing it',
    async (prefix) => {
      const sourceCookiesPath = seedProfile(Buffer.from(prefix))

      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(createDecipherivMock).not.toHaveBeenCalled()
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.summary.importedCookies).toBe(0)
      expect(result.summary.warning).toEqual({
        code: 'cookies-undecryptable',
        failedCookies: 1,
        reason: 'unknown'
      })
      expect(cookiesSetMock).not.toHaveBeenCalled()
    }
  )

  it('reports Windows app-bound (v20) cookies rather than an empty success', async () => {
    // Why: Chrome/Edge 140+ v20 rows can only be unwrapped by the writing browser.
    const sourceCookiesPath = seedProfile(
      Buffer.concat([Buffer.from('v20'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])])
    )

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.summary.importedCookies).toBe(0)
    expect(result.summary.warning).toEqual({
      code: 'cookies-undecryptable',
      failedCookies: 1,
      reason: 'app-bound-encryption'
    })
  })

  it('still imports v10 cookies, which is what a keyring-less profile actually holds', async () => {
    const sourceCookiesPath = seedProfile(encryptLinuxChromiumCookie('v10-value', 'peanuts', 'v10'))

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    // Mutation guard: replacing the keyring-unavailable branch with `return null` must break v10.
    expect(result.summary.importedCookies).toBe(1)
    expect(result.summary.warning).toBeUndefined()
    // Why (STA-4300): the write seam moved from cookies.set to the CDP identity store. The
    // assertion is adapted, not weakened — and it is now strictly stronger, because cookies.set
    // must not carry imported user data at all (that is the structural guard #14383/STA-4300 add).
    expect(writeCookieIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sid-0', value: 'v10-value' })
    )
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  it('uses an unknown warning when app-bound and corrupt failures are tied', async () => {
    const sourceCookiesPath = seedProfile(
      Buffer.concat([Buffer.from('v20'), Buffer.from([1, 2, 3, 4])]),
      Buffer.from('v99-corrupt')
    )

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.summary.warning).toEqual({
      code: 'cookies-undecryptable',
      failedCookies: 2,
      reason: 'unknown'
    })
  })

  it('reports a dominant app-bound cause with its exact count and the remainder', async () => {
    const appBoundValues = Array.from({ length: 200 }, () =>
      Buffer.concat([Buffer.from('v20'), Buffer.from([1, 2, 3, 4])])
    )
    const sourceCookiesPath = seedProfile(...appBoundValues, Buffer.from('v99-corrupt'))

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.summary.warning).toEqual({
      code: 'cookies-undecryptable',
      failedCookies: 200,
      otherFailedCookies: 1,
      reason: 'app-bound-encryption'
    })
  })
})
