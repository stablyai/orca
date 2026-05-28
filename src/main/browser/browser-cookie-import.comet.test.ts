import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as childProcessModule from 'node:child_process'
import type * as fsModule from 'node:fs'

const { sessionFromPartitionMock, dialogShowOpenDialogMock } = vi.hoisted(() => ({
  sessionFromPartitionMock: vi.fn(),
  dialogShowOpenDialogMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: dialogShowOpenDialogMock },
  session: { fromPartition: sessionFromPartitionMock }
}))

import { BROWSER_FAMILY_LABELS } from '../../shared/constants'
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
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes('Comet/Default/Network/Cookies')) {
            return true
          }
          if (p.includes('Comet/Local State')) {
            return true
          }
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
      const actual = await vi.importActual<typeof fsModule>('node:fs')
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
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes('Comet/Default/Network/Cookies')) {
            return true
          }
          if (p.includes('Comet/Local State')) {
            return true
          }
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
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes('Comet/Local State')) {
            return true
          }
          if (p.includes('Network/Cookies') || p.endsWith('/Cookies')) {
            return false
          }
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
      const actual = await vi.importActual<typeof childProcessModule>('node:child_process')
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
      const actual = await vi.importActual<typeof childProcessModule>('node:child_process')
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
