import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const sessionFromPartitionMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  session: { fromPartition: sessionFromPartitionMock }
}))

import {
  cookieHostBelongsToImportedDomain,
  importCookiesFromFile,
  isCookieImportDomainSafeForScopedClear,
  isGoogleIntegrityCookie
} from './browser-cookie-import'

describe('Google integrity cookie policy', () => {
  it('matches Google hosts and integrity names only', () => {
    expect(isGoogleIntegrityCookie('SIDCC', '.google.com')).toBe(true)
    expect(isGoogleIntegrityCookie('AEC', 'accounts.google.com')).toBe(true)
    expect(isGoogleIntegrityCookie('SIDCC', 'notgoogle.com')).toBe(false)
    expect(isGoogleIntegrityCookie('SID', '.google.com')).toBe(false)
    expect(isGoogleIntegrityCookie('AEC', 'example.com')).toBe(false)
  })

  it('scopes domain membership without suffix confusion', () => {
    const imported = new Set(['google.com', 'github.com'])
    expect(cookieHostBelongsToImportedDomain('.google.com', imported)).toBe(true)
    expect(cookieHostBelongsToImportedDomain('mail.google.com', imported)).toBe(true)
    expect(cookieHostBelongsToImportedDomain('notgoogle.com', imported)).toBe(false)
    expect(cookieHostBelongsToImportedDomain('evilgithub.com', imported)).toBe(false)
  })
})

describe('shared cookie import Google safeguards', () => {
  let tmpDir: string
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let cookiesGetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-policy-'))
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    cookiesGetMock = vi.fn().mockResolvedValue([])
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: { set: cookiesSetMock, get: cookiesGetMock, remove: cookiesRemoveMock }
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeCookieFile(cookies: unknown[]): string {
    const filePath = join(tmpDir, 'cookies.json')
    writeFileSync(filePath, JSON.stringify(cookies))
    return filePath
  }

  it('skips Google integrity cookies on the shared import path and counts them as skipped', async () => {
    const filePath = writeCookieFile([
      { domain: '.google.com', name: 'SIDCC', value: 'bound', secure: true },
      { domain: '.google.com', name: 'SID', value: 'session', secure: true },
      { domain: '.example.com', name: 'SIDCC', value: 'not-google', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.summary.totalCookies).toBe(3)
    expect(result.summary.importedCookies).toBe(2)
    expect(result.summary.skippedCookies).toBe(1)
    const names = cookiesSetMock.mock.calls.map((call) => call[0].name)
    expect(names).toEqual(expect.arrayContaining(['SID', 'SIDCC']))
    expect(names.filter((name) => name === 'SIDCC')).toHaveLength(1)
    expect(
      cookiesSetMock.mock.calls.find((call) => call[0].domain === '.example.com')?.[0].name
    ).toBe('SIDCC')
  })

  it('removes only conflicting cookies in imported domains before write', async () => {
    cookiesGetMock.mockResolvedValue([
      { domain: '.google.com', name: 'SID', secure: true },
      { domain: '.other.com', name: 'keep', secure: false }
    ])
    const filePath = writeCookieFile([
      { domain: '.google.com', name: 'SID', value: 'new', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    expect(cookiesRemoveMock).toHaveBeenCalledTimes(1)
    expect(cookiesRemoveMock.mock.calls[0][1]).toBe('SID')
    expect(cookiesSetMock).toHaveBeenCalledTimes(1)
  })

  it('refuses scoped clear for bare TLD / single-label import domains', () => {
    expect(isCookieImportDomainSafeForScopedClear('com')).toBe(false)
    expect(isCookieImportDomainSafeForScopedClear('.com')).toBe(false)
    expect(isCookieImportDomainSafeForScopedClear('localhost')).toBe(false)
    expect(isCookieImportDomainSafeForScopedClear('google.com')).toBe(true)
    expect(isCookieImportDomainSafeForScopedClear('.google.com')).toBe(true)
  })

  it('does not wipe *.com cookies when the import only carries a bare TLD domain', async () => {
    cookiesGetMock.mockResolvedValue([
      { domain: '.google.com', name: 'SID', secure: true },
      { domain: '.example.com', name: 'keep', secure: false }
    ])
    const filePath = writeCookieFile([
      { domain: 'com', name: 'evil', value: 'x', secure: false }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).toHaveBeenCalled()
  })

  it('does not clear existing cookies when the import is fully integrity-filtered', async () => {
    cookiesGetMock.mockResolvedValue([{ domain: '.google.com', name: 'SID', secure: true }])
    const filePath = writeCookieFile([
      { domain: '.google.com', name: 'SIDCC', value: 'bound', secure: true },
      { domain: 'accounts.google.com', name: 'AEC', value: 'bound', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.summary.importedCookies).toBe(0)
    expect(result.summary.skippedCookies).toBe(2)
    expect(cookiesGetMock).not.toHaveBeenCalled()
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })
})
