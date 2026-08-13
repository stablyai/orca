import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function slashPath(pathValue: string): string {
  return pathValue.replaceAll('\\', '/')
}

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
          const normalizedPath = slashPath(p)
          if (normalizedPath.includes('Comet/Default/Network/Cookies')) {
            return true
          }
          if (normalizedPath.includes('Comet/Local State')) {
            return true
          }
          return false
        },
        readFileSync: (p: string, enc?: string) => {
          if (typeof p === 'string' && slashPath(p).includes('Comet/Local State')) {
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
    expect(slashPath(comet?.cookiesPath ?? '')).toContain('Comet/Default/Network/Cookies')
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
          const normalizedPath = slashPath(p)
          if (normalizedPath.includes('Comet/Default/Network/Cookies')) {
            return true
          }
          if (normalizedPath.includes('Comet/Local State')) {
            return true
          }
          return false
        },
        readFileSync: (p: string, enc?: string) => {
          if (typeof p === 'string' && slashPath(p).includes('Comet/Local State')) {
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

  it('ignores Comet profile directories that escape the browser root', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes('Comet/Local State')) {
            return true
          }
          if (p.includes('Application Support/Outside/Network/Cookies')) {
            return true
          }
          return false
        },
        readFileSync: (p: string, enc?: string) => {
          if (typeof p === 'string' && p.includes('Comet/Local State')) {
            return JSON.stringify({
              profile: {
                info_cache: {
                  '../Outside': { name: 'Outside' }
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
    expect(detected.find((b) => b.family === 'comet')).toBeUndefined()
  })

  it('rejects explicit Comet profile selections that escape the browser root', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes('Application Support/Outside/Network/Cookies')) {
            return true
          }
          return false
        }
      }
    })

    const { selectBrowserProfile } = await import('./browser-cookie-import')
    const selected = selectBrowserProfile(
      {
        family: 'comet',
        label: 'Comet',
        cookiesPath: '/Users/test/Library/Application Support/Comet/Default/Network/Cookies',
        keychainService: 'Comet Safe Storage',
        keychainAccount: 'Comet',
        profiles: [{ name: 'Outside', directory: '../Outside' }],
        selectedProfile: 'Default'
      },
      '../Outside'
    )

    expect(selected).toBeNull()
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

describe('detectInstalledBrowsers — Comet on Windows', () => {
  const originalPlatform = process.platform
  const originalLocalAppData = process.env.LOCALAPPDATA

  const localAppData = 'C:\\Users\\test\\AppData\\Local'
  // Why: on Windows Comet installs under a Perplexity vendor directory, unlike its
  // macOS layout where the data dir sits directly under Application Support.
  const cometRoot = `${slashPath(localAppData)}/Perplexity/Comet/User Data`

  beforeEach(() => {
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.LOCALAPPDATA = localAppData
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    if (originalLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA
    } else {
      process.env.LOCALAPPDATA = originalLocalAppData
    }
    vi.restoreAllMocks()
  })

  // Why: these mocks compare the whole path instead of calling .includes(). A substring
  // match on 'Comet/Local State' is satisfied by both '<root>/Comet/User Data' and
  // '<root>/Perplexity/Comet/User Data', so it cannot tell a correct winRoot from one
  // that dropped the vendor segment — which is the regression these cases exist to catch.
  function mockCometInstallAt(rootPath: string): void {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) =>
          slashPath(p) === `${rootPath}/Local State` ||
          slashPath(p) === `${rootPath}/Default/Network/Cookies`,
        readFileSync: (p: string, enc?: string) => {
          if (typeof p === 'string' && slashPath(p) === `${rootPath}/Local State`) {
            return JSON.stringify({ profile: { info_cache: { Default: { name: 'Default' } } } })
          }
          return actual.readFileSync(p as never, enc as never)
        }
      }
    })
  }

  it('detects Comet under the Perplexity vendor directory', async () => {
    mockCometInstallAt(cometRoot)

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const comet = detectInstalledBrowsers().find((b) => b.family === 'comet')

    expect(comet).toBeDefined()
    expect(slashPath(comet?.cookiesPath ?? '')).toBe(`${cometRoot}/Default/Network/Cookies`)
  })

  it('does not detect a Comet data directory sitting directly under LOCALAPPDATA', async () => {
    mockCometInstallAt(`${slashPath(localAppData)}/Comet/User Data`)

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')

    expect(detectInstalledBrowsers().find((b) => b.family === 'comet')).toBeUndefined()
  })
})

describe('BROWSER_FAMILY_LABELS — Comet', () => {
  it('maps the comet family key to the user-facing label "Comet"', () => {
    expect(BROWSER_FAMILY_LABELS.comet).toBe('Comet')
  })
})
