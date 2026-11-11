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

describe('detectInstalledBrowsers — Comet', () => {
  const originalPlatform = process.platform
  const originalHome = process.env.HOME

  beforeEach(() => {
    // Reset cached imports before installing each filesystem mock.
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.HOME = '/Users/test'
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env.HOME = originalHome
    vi.restoreAllMocks()
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

    const { detectInstalledBrowsers } = await import('./sources/browser-cookie-detection')
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

    const { selectBrowserProfile } = await import('./sources/browser-cookie-detection')
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
})
