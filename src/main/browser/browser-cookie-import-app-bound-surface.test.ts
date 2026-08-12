import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetPathMock, execFileSyncMock, sessionFromPartitionMock } = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  sessionFromPartitionMock: vi.fn()
}))

vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: vi.fn(),
    clearPendingCookieImport: vi.fn(),
    persistUserAgent: vi.fn()
  }
}))
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))
vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  dialog: { showOpenDialog: vi.fn() },
  session: { fromPartition: sessionFromPartitionMock }
}))

import { importCookiesFromBrowser } from './browser-cookie-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A Chrome 140+ app-bound cookie: the `v20` prefix over an opaque blob. */
function appBoundEncryptedValue(): Buffer {
  return Buffer.concat([Buffer.from('v20'), Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])])
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

describe('app-bound encrypted cookies reach the import summary', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-app-bound-'))
    appGetPathMock.mockReset().mockReturnValue(join(tmpDir, 'userData'))
    // Why: a real Chrome 140 profile on Windows HAS a working key — the rows still fail because
    // they are app-bound, which is the scenario under test.
    execFileSyncMock.mockReset().mockReturnValue('safe-storage-password')
    sessionFromPartitionMock.mockReset().mockReturnValue({
      cookies: {
        flushStore: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue([]),
        remove: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined)
      },
      clearStorageData: vi.fn().mockResolvedValue(undefined)
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // Why: the predicate alone proves nothing — before this fix the rows decoded to nothing and were
  // folded into the generic skip count, so the import reported a clean zero (#13192). This drives
  // the real import and asserts the cause reaches the caller.
  it('reports the cause instead of a silent zero', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      {
        domain: '.github.com',
        name: 'session',
        value: '',
        encryptedValue: appBoundEncryptedValue()
      },
      { domain: '.example.com', name: 'token', value: '', encryptedValue: appBoundEncryptedValue() }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      if (!result.ok) {
        throw new Error(`import failed: ${result.reason}`)
      }
      expect(result.summary.importedCookies).toBe(0)
      expect(result.summary.totalCookies).toBe(2)
      expect(result.summary.warning).toEqual({
        code: 'app-bound-encryption',
        encryptedCookies: 2
      })
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('leaves a decryptable profile without the warning', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { domain: '.github.com', name: 'plain', value: 'readable' }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.summary.warning).toBeUndefined()
    } finally {
      platformSpy.mockRestore()
    }
  })
})
