import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sessionFromPartitionMock, dialogShowOpenDialogMock } = vi.hoisted(() => ({
  sessionFromPartitionMock: vi.fn(),
  dialogShowOpenDialogMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: dialogShowOpenDialogMock },
  session: { fromPartition: sessionFromPartitionMock }
}))

import { importCookiesFromFile, detectInstalledBrowsers } from './browser-cookie-import'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BROWSER_FAMILY_LABELS } from '../../shared/constants'

describe('importCookiesFromFile', () => {
  let tmpDir: string
  let cookiesSetMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-test-'))
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: { set: cookiesSetMock }
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

  it('imports valid cookies', async () => {
    const filePath = writeCookieFile([
      {
        domain: '.github.com',
        name: '_gh_sess',
        value: 'abc123',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: 1800000000
      },
      {
        domain: '.example.com',
        name: 'test',
        value: 'val',
        path: '/',
        secure: false,
        httpOnly: false
      }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.summary.totalCookies).toBe(2)
    expect(result.summary.importedCookies).toBe(2)
    expect(result.summary.skippedCookies).toBe(0)
    expect(result.summary.domains).toContain('github.com')
    expect(result.summary.domains).toContain('example.com')

    expect(cookiesSetMock).toHaveBeenCalledTimes(2)
    const firstCall = cookiesSetMock.mock.calls[0][0]
    expect(firstCall.name).toBe('_gh_sess')
    expect(firstCall.domain).toBe('.github.com')
    expect(firstCall.secure).toBe(true)
    expect(firstCall.sameSite).toBe('lax')
  })

  it('rejects non-JSON files', async () => {
    const filePath = join(tmpDir, 'bad.json')
    writeFileSync(filePath, 'not json at all')

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('not valid JSON')
  })

  it('rejects non-array JSON', async () => {
    const filePath = join(tmpDir, 'object.json')
    writeFileSync(filePath, '{"domain": "test.com"}')

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('JSON array')
  })

  it('rejects empty array', async () => {
    const filePath = writeCookieFile([])
    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('empty')
  })

  it('skips entries with missing required fields', async () => {
    const filePath = writeCookieFile([
      { domain: '.valid.com', name: 'ok', value: 'val' },
      { name: 'no-domain', value: 'val' },
      { domain: '.valid2.com', value: 'no-name' },
      { domain: '.valid3.com', name: 'no-value' },
      'not an object',
      42
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.summary.importedCookies).toBe(1)
    expect(result.summary.skippedCookies).toBe(5)
  })

  it('reports all skipped when no valid cookies', async () => {
    const filePath = writeCookieFile([
      { name: 'no-domain', value: 'val' },
      { domain: '', name: 'empty-domain', value: 'val' }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('No valid cookies')
    expect(result.reason).toContain('2 entries were skipped')
  })

  it('handles file read errors', async () => {
    const result = await importCookiesFromFile('/nonexistent/path.json', 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('Could not read')
  })

  it('normalizes sameSite values', async () => {
    const filePath = writeCookieFile([
      { domain: '.test.com', name: 'a', value: '1', sameSite: 'None' },
      { domain: '.test.com', name: 'b', value: '2', sameSite: 'Lax' },
      { domain: '.test.com', name: 'c', value: '3', sameSite: 'Strict' },
      { domain: '.test.com', name: 'd', value: '4', sameSite: 'unknown' },
      { domain: '.test.com', name: 'e', value: '5' }
    ])

    await importCookiesFromFile(filePath, 'persist:test')

    expect(cookiesSetMock.mock.calls[0][0].sameSite).toBe('no_restriction')
    expect(cookiesSetMock.mock.calls[1][0].sameSite).toBe('lax')
    expect(cookiesSetMock.mock.calls[2][0].sameSite).toBe('strict')
    expect(cookiesSetMock.mock.calls[3][0].sameSite).toBe('unspecified')
    expect(cookiesSetMock.mock.calls[4][0].sameSite).toBe('unspecified')
  })

  it('derives correct URL from domain and secure flag', async () => {
    const filePath = writeCookieFile([
      { domain: '.secure.com', name: 'a', value: '1', secure: true },
      { domain: '.insecure.com', name: 'b', value: '2', secure: false },
      { domain: 'nodot.com', name: 'c', value: '3' }
    ])

    await importCookiesFromFile(filePath, 'persist:test')

    expect(cookiesSetMock.mock.calls[0][0].url).toBe('https://secure.com/')
    expect(cookiesSetMock.mock.calls[1][0].url).toBe('http://insecure.com/')
    expect(cookiesSetMock.mock.calls[2][0].url).toBe('http://nodot.com/')
  })

  it('counts cookies that fail to set', async () => {
    cookiesSetMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('set failed'))

    const filePath = writeCookieFile([
      { domain: '.a.com', name: 'ok', value: '1' },
      { domain: '.b.com', name: 'fail', value: '2' }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.summary.importedCookies).toBe(1)
    expect(result.summary.skippedCookies).toBe(1)
  })
})

describe('detectInstalledBrowsers', () => {
  it('returns an array of detected browsers', () => {
    const browsers = detectInstalledBrowsers()
    expect(Array.isArray(browsers)).toBe(true)
    for (const browser of browsers) {
      expect(browser).toHaveProperty('family')
      expect(browser).toHaveProperty('label')
      expect(browser).toHaveProperty('cookiesPath')
      // keychainService/keychainAccount are only present for Chromium-based browsers
      if (['chrome', 'edge', 'arc', 'chromium'].includes(browser.family)) {
        expect(browser).toHaveProperty('keychainService')
        expect(browser).toHaveProperty('keychainAccount')
      }
    }
  })

  it('each detected browser has a valid family', () => {
    const browsers = detectInstalledBrowsers()
    const validFamilies = ['chrome', 'edge', 'arc', 'chromium', 'firefox', 'safari', 'comet']
    for (const browser of browsers) {
      expect(validFamilies).toContain(browser.family)
    }
  })
})

describe('detectInstalledBrowsers — Comet', () => {
  const originalPlatform = process.platform
  const originalHome = process.env.HOME

  beforeEach(() => {
    // Why: browser-cookie-import.ts uses destructured named imports from
    // 'node:fs' which are bound at module-load time. Without vi.resetModules(),
    // only the first test's vi.doMock takes effect — subsequent tests see the
    // cached module with the first mock still applied. resetModules must run
    // BEFORE each doMock so the next import() picks up the fresh mock factory.
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.HOME = '/Users/test'
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env.HOME = originalHome
    vi.restoreAllMocks()
  })

  it('detects Comet when its data directory and Cookies DB exist', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes('Comet/Default/Network/Cookies')) return true
          if (p.includes('Comet/Local State')) return true
          return false
        },
        readFileSync: (p: string, enc?: string) => {
          if (typeof p === 'string' && p.includes('Comet/Local State')) {
            return JSON.stringify({ profile: { info_cache: { Default: { name: 'Default' } } } })
          }
          return actual.readFileSync(p as never, enc as never)
        }
      }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const detected = detectInstalledBrowsers()
    const comet = detected.find((b) => b.family === 'comet')
    expect(comet).toBeDefined()
    expect(comet?.label).toBe('Comet')
    expect(comet?.cookiesPath).toContain('Comet/Default/Network/Cookies')
    expect(comet?.keychainService).toBe('Comet Safe Storage')
  })

  it('does not list Comet when its data directory is absent', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        existsSync: () => false
      }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const detected = detectInstalledBrowsers()
    expect(detected.find((b) => b.family === 'comet')).toBeUndefined()
  })

  it('enumerates all Comet profiles from Local State info_cache', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes('Comet/Default/Network/Cookies')) return true
          if (p.includes('Comet/Local State')) return true
          return false
        },
        readFileSync: (p: string, enc?: string) => {
          if (typeof p === 'string' && p.includes('Comet/Local State')) {
            return JSON.stringify({
              profile: {
                info_cache: {
                  Default: { name: 'Personal' },
                  'Profile 1': { name: 'Work' },
                  'Profile 2': { name: 'Research' }
                }
              }
            })
          }
          return actual.readFileSync(p as never, enc as never)
        }
      }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const detected = detectInstalledBrowsers()
    const comet = detected.find((b) => b.family === 'comet')
    expect(comet).toBeDefined()
    const directories = comet!.profiles.map((p) => p.directory).sort()
    expect(directories).toEqual(['Default', 'Profile 1', 'Profile 2'])
    const names = comet!.profiles.map((p) => p.name).sort()
    expect(names).toEqual(['Personal', 'Research', 'Work'])
  })

  it('skips Comet when the data directory exists but no Cookies DB is present', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes('Comet/Local State')) return true
          if (p.includes('Network/Cookies') || p.endsWith('/Cookies')) return false
          return false
        },
        readFileSync: (p: string, enc?: string) => {
          if (typeof p === 'string' && p.includes('Comet/Local State')) {
            return JSON.stringify({ profile: { info_cache: { Default: { name: 'Default' } } } })
          }
          return actual.readFileSync(p as never, enc as never)
        }
      }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const detected = detectInstalledBrowsers()
    expect(detected.find((b) => b.family === 'comet')).toBeUndefined()
  })
})

describe('getUserAgentForBrowser — Comet', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    vi.restoreAllMocks()
  })

  it('returns a Chrome-shaped UA string when Comet plist version reads successfully', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      return {
        ...actual,
        execFileSync: (cmd: string, args: readonly string[]) => {
          if (cmd === 'defaults' && args[1]?.includes('/Applications/Comet.app/Contents/Info')) {
            return '120.0.6099.71\n'
          }
          return actual.execFileSync(cmd, args as never)
        }
      }
    })

    const { getUserAgentForBrowser } = await import('./browser-cookie-import')
    const ua = getUserAgentForBrowser('comet')

    expect(ua).not.toBeNull()
    expect(ua).toContain('Macintosh; Intel Mac OS X 10_15_7')
    expect(ua).toContain('AppleWebKit/537.36')
    expect(ua).toContain('Chrome/120.0.6099.71')
    expect(ua).toContain('Safari/537.36')
  })

  it('returns null when reading the Comet plist version throws', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      return {
        ...actual,
        execFileSync: () => {
          throw new Error('defaults: domain not found')
        }
      }
    })

    const { getUserAgentForBrowser } = await import('./browser-cookie-import')
    const ua = getUserAgentForBrowser('comet')
    expect(ua).toBeNull()
  })

  it('returns null on non-darwin platforms regardless of family', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const { getUserAgentForBrowser } = await import('./browser-cookie-import')
    const ua = getUserAgentForBrowser('comet')
    expect(ua).toBeNull()
  })
})

describe('BROWSER_FAMILY_LABELS — Comet', () => {
  it('maps the comet family key to the user-facing label "Comet"', () => {
    expect(BROWSER_FAMILY_LABELS.comet).toBe('Comet')
  })
})
