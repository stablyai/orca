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

describe('detectInstalledBrowsers — Helium', () => {
  const originalPlatform = process.platform
  const originalHome = process.env.HOME

  beforeEach(() => {
    // Why: browser-cookie-import.ts uses destructured named imports from
    // 'node:fs' which are bound at module-load time. resetModules must run
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

  it('detects Helium under its bundle-id data dir via the legacy Cookies path', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          const normalizedPath = slashPath(p)
          // Why: Helium stores cookies at the legacy <Profile>/Cookies path, so the
          // newer Network/Cookies probe must miss and the legacy fallback must fire.
          if (normalizedPath.includes('net.imput.helium/Default/Network/Cookies')) {
            return false
          }
          if (normalizedPath.endsWith('net.imput.helium/Default/Cookies')) {
            return true
          }
          if (normalizedPath.includes('net.imput.helium/Local State')) {
            return true
          }
          return false
        },
        readFileSync: (p: string, enc?: string) => {
          if (typeof p === 'string' && slashPath(p).includes('net.imput.helium/Local State')) {
            return JSON.stringify({ profile: { info_cache: { Default: { name: 'Default' } } } })
          }
          return actual.readFileSync(p as never, enc as never)
        }
      }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const detected = detectInstalledBrowsers()
    const helium = detected.find((b) => b.family === 'helium')
    expect(helium).toBeDefined()
    expect(helium?.label).toBe('Helium')
    expect(slashPath(helium?.cookiesPath ?? '')).toContain('net.imput.helium/Default/Cookies')
    expect(slashPath(helium?.cookiesPath ?? '')).not.toContain('Network/Cookies')
    expect(helium?.keychainService).toBe('Helium Storage Key')
    expect(helium?.keychainAccount).toBe('Helium')
  })

  it('does not list Helium when its data directory is absent', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: () => false
      }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const detected = detectInstalledBrowsers()
    expect(detected.find((b) => b.family === 'helium')).toBeUndefined()
  })

  it('enumerates all Helium profiles from Local State info_cache', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          const normalizedPath = slashPath(p)
          if (normalizedPath.endsWith('net.imput.helium/Default/Cookies')) {
            return true
          }
          if (normalizedPath.includes('net.imput.helium/Local State')) {
            return true
          }
          return false
        },
        readFileSync: (p: string, enc?: string) => {
          if (typeof p === 'string' && slashPath(p).includes('net.imput.helium/Local State')) {
            return JSON.stringify({
              profile: {
                info_cache: {
                  Default: { name: 'Personal' },
                  'Profile 1': { name: 'Work' }
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
    const helium = detected.find((b) => b.family === 'helium')
    expect(helium).toBeDefined()
    const directories = helium!.profiles.map((p) => p.directory).sort()
    expect(directories).toEqual(['Default', 'Profile 1'])
  })

  it('rejects explicit Helium profile selections that escape the browser root', async () => {
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
        family: 'helium',
        label: 'Helium',
        cookiesPath: '/Users/test/Library/Application Support/net.imput.helium/Default/Cookies',
        keychainService: 'Helium Storage Key',
        keychainAccount: 'Helium',
        profiles: [{ name: 'Outside', directory: '../Outside' }],
        selectedProfile: 'Default'
      },
      '../Outside'
    )

    expect(selected).toBeNull()
  })
})

describe('BROWSER_FAMILY_LABELS — Helium', () => {
  it('maps the helium family key to the user-facing label "Helium"', () => {
    expect(BROWSER_FAMILY_LABELS.helium).toBe('Helium')
  })
})
