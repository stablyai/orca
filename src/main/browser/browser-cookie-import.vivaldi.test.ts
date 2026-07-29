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

/** Normalize platform-specific separators for cross-platform path assertions. */
function slashPath(pathValue: string): string {
  return pathValue.replaceAll('\\', '/')
}

type VivaldiInstallMockOptions = {
  pathExistsOverride?: (normalizedPath: string) => boolean | undefined
  infoCache?: Record<string, { name: string }>
}

/** Mock Vivaldi's filesystem layout and profile metadata for detection tests. */
function mockVivaldiInstall(
  cookiesDirFragment: string,
  localStateFragment: string,
  options: VivaldiInstallMockOptions = {}
): void {
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof fsModule>('node:fs')
    return {
      ...actual,
      existsSync: (p: string) => {
        const normalizedPath = slashPath(p)
        const overriddenResult = options.pathExistsOverride?.(normalizedPath)
        if (overriddenResult !== undefined) {
          return overriddenResult
        }
        if (normalizedPath.includes(cookiesDirFragment)) {
          return true
        }
        return normalizedPath.includes(localStateFragment)
      },
      readFileSync: (p: string, enc?: string) => {
        if (typeof p === 'string' && slashPath(p).includes(localStateFragment)) {
          return JSON.stringify({
            profile: { info_cache: options.infoCache ?? { Default: { name: 'Default' } } }
          })
        }
        return actual.readFileSync(p as never, enc as never)
      }
    }
  })
}

/** Verify Vivaldi detection across its supported platform-specific data directories. */
describe('detectInstalledBrowsers — Vivaldi', () => {
  const originalPlatform = process.platform
  const originalHome = process.env.HOME
  const originalLocalAppData = process.env.LOCALAPPDATA
  const originalConfigHome = process.env.XDG_CONFIG_HOME

  beforeEach(() => {
    // Why: browser-cookie-import.ts binds named 'node:fs' imports at module-load
    // time, so resetModules must run BEFORE each doMock for the mock to apply.
    vi.resetModules()
    process.env.HOME = '/Users/test'
    process.env.LOCALAPPDATA = 'C:/Users/test/AppData/Local'
    process.env.XDG_CONFIG_HOME = '/home/test/.config'
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env.HOME = originalHome
    process.env.LOCALAPPDATA = originalLocalAppData
    process.env.XDG_CONFIG_HOME = originalConfigHome
    vi.restoreAllMocks()
  })

  it('detects Vivaldi under the macOS Application Support root', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    mockVivaldiInstall('Vivaldi/Default/Network/Cookies', 'Vivaldi/Local State')

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const vivaldi = detectInstalledBrowsers().find((b) => b.family === 'vivaldi')
    expect(vivaldi).toBeDefined()
    expect(vivaldi?.label).toBe('Vivaldi')
    expect(slashPath(vivaldi?.cookiesPath ?? '')).toContain(
      'Library/Application Support/Vivaldi/Default/Network/Cookies'
    )
    expect(vivaldi?.keychainService).toBe('Vivaldi Safe Storage')
    expect(vivaldi?.keychainAccount).toBe('Vivaldi')
  })

  it('detects Vivaldi under the Windows LOCALAPPDATA User Data root', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockVivaldiInstall('Vivaldi/User Data/Default/Network/Cookies', 'Vivaldi/User Data/Local State')

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const vivaldi = detectInstalledBrowsers().find((b) => b.family === 'vivaldi')
    expect(vivaldi).toBeDefined()
    expect(slashPath(vivaldi?.cookiesPath ?? '')).toContain(
      'AppData/Local/Vivaldi/User Data/Default/Network/Cookies'
    )
  })

  it('detects Vivaldi under the Linux XDG config root', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    mockVivaldiInstall('vivaldi/Default/Network/Cookies', 'vivaldi/Local State')

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const vivaldi = detectInstalledBrowsers().find((b) => b.family === 'vivaldi')
    expect(vivaldi).toBeDefined()
    expect(slashPath(vivaldi?.cookiesPath ?? '')).toContain(
      '/home/test/.config/vivaldi/Default/Network/Cookies'
    )
  })

  it('falls back to the legacy profile-root Cookies path', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    mockVivaldiInstall('Vivaldi/Default/Network/Cookies', 'Vivaldi/Local State', {
      pathExistsOverride: (normalizedPath) => {
        if (normalizedPath.includes('Vivaldi/Default/Network/Cookies')) {
          return false
        }
        if (normalizedPath.endsWith('Vivaldi/Default/Cookies')) {
          return true
        }
        return undefined
      }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const vivaldi = detectInstalledBrowsers().find((b) => b.family === 'vivaldi')
    expect(slashPath(vivaldi?.cookiesPath ?? '')).toContain('Vivaldi/Default/Cookies')
    expect(slashPath(vivaldi?.cookiesPath ?? '')).not.toContain('Network/Cookies')
  })

  it('does not list Vivaldi when its data directory is absent', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: () => false
      }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const detected = detectInstalledBrowsers()
    expect(detected.find((b) => b.family === 'vivaldi')).toBeUndefined()
  })

  it('enumerates all Vivaldi profiles from Local State info_cache', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    mockVivaldiInstall('Vivaldi/Default/Network/Cookies', 'Vivaldi/Local State', {
      infoCache: {
        Default: { name: 'Personal' },
        'Profile 1': { name: 'Work' }
      }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const vivaldi = detectInstalledBrowsers().find((b) => b.family === 'vivaldi')
    expect(vivaldi).toBeDefined()
    expect(vivaldi!.profiles).toEqual([
      { name: 'Personal', directory: 'Default' },
      { name: 'Work', directory: 'Profile 1' }
    ])
  })

  it('rejects explicit Vivaldi profile selections that escape the browser root', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => slashPath(p).includes('Application Support/Outside/Cookies')
      }
    })

    const { selectBrowserProfile } = await import('./browser-cookie-import')
    const selected = selectBrowserProfile(
      {
        family: 'vivaldi',
        label: 'Vivaldi',
        cookiesPath: '/Users/test/Library/Application Support/Vivaldi/Default/Network/Cookies',
        keychainService: 'Vivaldi Safe Storage',
        keychainAccount: 'Vivaldi',
        profiles: [{ name: 'Outside', directory: '../Outside' }],
        selectedProfile: 'Default'
      },
      '../Outside'
    )

    expect(selected).toBeNull()
  })
})

/** Verify that Vivaldi uses Electron's default user-agent handling. */
describe('getUserAgentForBrowser — Vivaldi', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    vi.restoreAllMocks()
  })

  it('returns a Chrome-shaped UA string when Vivaldi plist version reads successfully', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof childProcessModule>('node:child_process')
      return {
        ...actual,
        execFileSync: (cmd: string, args: readonly string[]) => {
          if (cmd === 'defaults' && args[1]?.includes('/Applications/Vivaldi.app/Contents/Info')) {
            return '120.0.6099.71\n'
          }
          return actual.execFileSync(cmd, args as never)
        }
      }
    })

    const { getUserAgentForBrowser } = await import('./browser-cookie-import')
    const ua = getUserAgentForBrowser('vivaldi')

    expect(ua).not.toBeNull()
    expect(ua).toContain('Macintosh; Intel Mac OS X 10_15_7')
    expect(ua).toContain('AppleWebKit/537.36')
    expect(ua).toContain('Chrome/120.0.6099.71')
    expect(ua).toContain('Safari/537.36')
  })

  it('returns null when reading the Vivaldi plist version throws', async () => {
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
    const ua = getUserAgentForBrowser('vivaldi')
    expect(ua).toBeNull()
  })

  it('returns null on Windows and Linux, where the default Electron UA is used', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      Object.defineProperty(process, 'platform', { value: platform })
      vi.resetModules()
      const { getUserAgentForBrowser } = await import('./browser-cookie-import')
      expect(getUserAgentForBrowser('vivaldi')).toBeNull()
    }
  })
})

/** Verify the user-facing label for the Vivaldi browser family. */
describe('BROWSER_FAMILY_LABELS — Vivaldi', () => {
  it('maps the vivaldi family key to the user-facing label "Vivaldi"', () => {
    expect(BROWSER_FAMILY_LABELS.vivaldi).toBe('Vivaldi')
  })
})
