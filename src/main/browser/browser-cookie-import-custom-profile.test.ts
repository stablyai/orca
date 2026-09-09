import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as fsModule from 'node:fs'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  session: { fromPartition: vi.fn() }
}))

function slashPath(pathValue: string): string {
  return pathValue.replaceAll('\\', '/')
}

// A custom (auto-discovered) browser whose selected profile is Default and whose data
// root is derived from cookiesPath. selectBrowserProfile must re-derive that root to
// resolve a different profile's cookies DB.
const customBrowser = {
  family: 'custom' as const,
  label: 'Ghosty',
  cookiesPath: '/Users/test/Library/Application Support/Ghosty/Default/Cookies',
  keychainService: 'Ghosty Safe Storage',
  keychainAccount: 'Ghosty',
  profiles: [
    { name: 'Personal', directory: 'Default' },
    { name: 'Work', directory: 'Profile 1' }
  ],
  selectedProfile: 'Default'
}

describe('selectBrowserProfile — custom browser', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reselects a non-Default profile by deriving the data root from cookiesPath', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        // Profile 1 stores its cookies on the modern Network/Cookies path.
        existsSync: (p: string) => slashPath(p).endsWith('Ghosty/Profile 1/Network/Cookies')
      }
    })

    const { selectBrowserProfile } = await import('./browser-cookie-import')
    const selected = selectBrowserProfile(customBrowser, 'Profile 1')

    expect(selected?.selectedProfile).toBe('Profile 1')
    expect(slashPath(selected?.cookiesPath ?? '')).toBe(
      '/Users/test/Library/Application Support/Ghosty/Profile 1/Network/Cookies'
    )
  })

  it('returns null when the reselected profile has no cookies DB', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return { ...actual, existsSync: () => false }
    })

    const { selectBrowserProfile } = await import('./browser-cookie-import')
    expect(selectBrowserProfile(customBrowser, 'Profile 1')).toBeNull()
  })

  it('rejects a traversal profile directory before touching the filesystem', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return { ...actual, existsSync: () => true }
    })

    const { selectBrowserProfile } = await import('./browser-cookie-import')
    expect(selectBrowserProfile(customBrowser, '../Outside')).toBeNull()
  })
})
