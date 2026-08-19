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

describe('detectInstalledBrowsers — Aside', () => {
  const originalPlatform = process.platform
  const originalHome = process.env.HOME

  beforeEach(() => {
    // Why: browser-cookie-import.ts uses destructured named imports from
    // 'node:fs' bound at module-load time. resetModules must run BEFORE each
    // doMock so the next import() picks up the fresh mock factory.
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.HOME = '/Users/test'
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env.HOME = originalHome
    vi.restoreAllMocks()
  })

  it('detects Aside under Application Support/Aside via the legacy Cookies path', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          const normalizedPath = slashPath(p)
          // Why: Aside stores cookies at the legacy <Profile>/Cookies path, so the
          // newer Network/Cookies probe must miss and the legacy fallback must fire.
          if (normalizedPath.includes('Application Support/Aside/Default/Network/Cookies')) {
            return false
          }
          if (normalizedPath.endsWith('Application Support/Aside/Default/Cookies')) {
            return true
          }
          if (normalizedPath.includes('Application Support/Aside/Local State')) {
            return true
          }
          return false
        },
        readFileSync: (p: string, enc?: string) => {
          if (
            typeof p === 'string' &&
            slashPath(p).includes('Application Support/Aside/Local State')
          ) {
            return JSON.stringify({ profile: { info_cache: { Default: { name: 'Default' } } } })
          }
          return actual.readFileSync(p as never, enc as never)
        }
      }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const detected = detectInstalledBrowsers()
    const aside = detected.find((b) => b.family === 'aside')
    expect(aside).toBeDefined()
    expect(aside?.label).toBe('Aside')
    expect(slashPath(aside?.cookiesPath ?? '')).toContain(
      'Application Support/Aside/Default/Cookies'
    )
    expect(slashPath(aside?.cookiesPath ?? '')).not.toContain('Network/Cookies')
    expect(aside?.keychainService).toBe('Aside Safe Storage')
    expect(aside?.keychainAccount).toBe('Aside')
  })

  it('does not list Aside when its data directory is absent', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: () => false
      }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const detected = detectInstalledBrowsers()
    expect(detected.find((b) => b.family === 'aside')).toBeUndefined()
  })

  it('enumerates all Aside profiles from Local State info_cache', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          const normalizedPath = slashPath(p)
          if (normalizedPath.endsWith('Application Support/Aside/Default/Cookies')) {
            return true
          }
          if (normalizedPath.includes('Application Support/Aside/Local State')) {
            return true
          }
          return false
        },
        readFileSync: (p: string, enc?: string) => {
          if (
            typeof p === 'string' &&
            slashPath(p).includes('Application Support/Aside/Local State')
          ) {
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
    const aside = detected.find((b) => b.family === 'aside')
    expect(aside).toBeDefined()
    const directories = aside!.profiles.map((p) => p.directory).sort()
    expect(directories).toEqual(['Default', 'Profile 1'])
  })

  it('rejects explicit Aside profile selections that escape the browser root', async () => {
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
        family: 'aside',
        label: 'Aside',
        cookiesPath: '/Users/test/Library/Application Support/Aside/Default/Cookies',
        keychainService: 'Aside Safe Storage',
        keychainAccount: 'Aside',
        profiles: [{ name: 'Outside', directory: '../Outside' }],
        selectedProfile: 'Default'
      },
      '../Outside'
    )

    expect(selected).toBeNull()
  })
})

describe('BROWSER_FAMILY_LABELS — Aside', () => {
  it('maps the aside family key to the user-facing label "Aside"', () => {
    expect(BROWSER_FAMILY_LABELS.aside).toBe('Aside')
  })
})
