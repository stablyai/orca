import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeCrypto from 'node:crypto'
import type { CookiesGetFilter } from 'electron'

const {
  appGetPathMock,
  createDecipherivMock,
  runProcessMock,
  sessionFromPartitionMock,
  dialogShowOpenDialogMock,
  setPendingCookieImportMock,
  clearPendingCookieImportMock,
  writeCookieIdentityMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  createDecipherivMock: vi.fn(),
  runProcessMock: vi.fn(),
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
vi.mock('../../sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: setPendingCookieImportMock,
    clearPendingCookieImport: clearPendingCookieImportMock
  }
}))
vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock
}))
vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: dialogShowOpenDialogMock },
  session: { fromPartition: sessionFromPartitionMock }
}))
vi.mock('../browser-cookie-clear-store', () => ({
  openCookieClearStore: (targetSession: {
    cookies: {
      get: (filter: CookiesGetFilter) => Promise<unknown>
      remove: (url: string, name: string) => Promise<void>
    }
  }) => ({
    get: (filter: CookiesGetFilter) => targetSession.cookies.get(filter),
    remove: (url: string, name: string) => targetSession.cookies.remove(url, name),
    snapshotClearIdentities: async (items: { cookie: Record<string, unknown>; url: string }[]) =>
      items.map(({ cookie, url }) => ({ url, ...cookie })),
    restoreClearIdentities: async () => undefined,
    // Implement CDP writes so swallowed missing-method errors cannot fake successful coverage.
    writeCookieIdentity: writeCookieIdentityMock,
    dispose: () => undefined
  })
}))

import { importCookiesFromBrowser } from '../browser-cookie-import'
import type { DetectedBrowser } from './browser-cookie-source-profiles'
import { createChromiumCookieTestDatabase } from '../browser-cookie-import-test-database'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCipheriv, pbkdf2Sync } from 'node:crypto'

// Linux PBKDF2 uses one round; the macOS fixture helper uses 1003.
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
  let platformSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-linux-keyring-test-'))
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    clearDataMock = vi.fn().mockResolvedValue(undefined)
    writeCookieIdentityMock.mockReset().mockResolvedValue(undefined)
    appGetPathMock.mockReturnValue(join(tmpDir, 'userData'))
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: vi.fn(async () => []),
        set: cookiesSetMock,
        remove: cookiesRemoveMock,
        flushStore: vi.fn().mockResolvedValue(undefined)
      },
      clearData: clearDataMock,
      setUserAgent: vi.fn(),
      getStoragePath: vi.fn().mockReturnValue(join(tmpDir, 'userData', 'Partitions', 'test'))
    })
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    runProcessMock.mockRejectedValue(new Error('secret-tool: no such service'))
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
    runProcessMock.mockRejectedValue(
      Object.assign(new Error('spawn secret-tool failed'), { code: 'ENOENT' })
    )
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
      reason: 'linux-keyring-unavailable',
      keyringFailure: { cause: 'secret-tool-missing', browser: 'Google Chrome' }
    })
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  it('still imports v10 cookies, which is what a keyring-less profile actually holds', async () => {
    const sourceCookiesPath = seedProfile(encryptLinuxChromiumCookie('v10-value', 'peanuts', 'v10'))

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.summary.importedCookies).toBe(1)
    expect(result.summary.warning).toBeUndefined()
    expect(writeCookieIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sid-0', value: 'v10-value' })
    )
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })
})
