import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DiscoveredBrowserCandidate,
  ExistsSync,
  ReadTextFileSync
} from './installed-browser-discovery'

// Why: this module never touches Electron, but mirror the browser-cookie-import
// suites' electron mock so the shared main-process import graph stays inert.
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  session: { fromPartition: vi.fn() }
}))

function slashPath(pathValue: string): string {
  return pathValue.replaceAll('\\', '/')
}

// Fixture mirroring a real macOS machine: three Chromium browsers, one terminal, one WebKit browser.
const MACHINE_CANDIDATES: DiscoveredBrowserCandidate[] = [
  { bundleId: 'ai.perplexity.comet', displayName: 'Comet', appPath: '/Applications/Comet.app' },
  { bundleId: 'at.studio.AsideBrowser', displayName: 'Aside', appPath: '/Applications/Aside.app' },
  { bundleId: 'com.apple.Safari', displayName: 'Safari', appPath: '/Applications/Safari.app' },
  {
    bundleId: 'com.google.Chrome',
    displayName: 'Google Chrome',
    appPath: '/Applications/Google Chrome.app'
  },
  { bundleId: 'com.googlecode.iterm2', displayName: 'iTerm', appPath: '/Applications/iTerm.app' }
]

const APP_SUPPORT_ROOT = '/Users/test/Library/Application Support'

describe('discoverInstalledBrowsers — darwin', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns every candidate the injected OS URL-handler query reports', async () => {
    const { discoverInstalledBrowsers } = await import('./installed-browser-discovery')
    const queryHttpsHandlers = vi.fn().mockResolvedValue(MACHINE_CANDIDATES)

    const discovered = await discoverInstalledBrowsers({ platform: 'darwin', queryHttpsHandlers })

    expect(queryHttpsHandlers).toHaveBeenCalledTimes(1)
    expect(discovered).toEqual(MACHINE_CANDIDATES)
  })

  it('defaults to an empty result when no query seam is injected', async () => {
    const { discoverInstalledBrowsers } = await import('./installed-browser-discovery')
    const discovered = await discoverInstalledBrowsers({ platform: 'darwin' })
    expect(discovered).toEqual([])
  })
})

describe('filterChromiumCandidates — darwin', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps only candidates that own a Chromium cookie store and drops iTerm + Safari', async () => {
    const { filterChromiumCandidates } = await import('./installed-browser-discovery')

    // Aside/Comet on the modern Network/Cookies path, Chrome on the legacy Cookies path.
    const existsSync: ExistsSync = (rawPath) => {
      const p = slashPath(rawPath)
      if (p.endsWith('Aside/Local State')) {
        return true
      }
      if (p.endsWith('Aside/Default/Network/Cookies')) {
        return true
      }
      if (p.endsWith('Comet/Local State')) {
        return true
      }
      if (p.endsWith('Comet/Default/Network/Cookies')) {
        return true
      }
      if (p.endsWith('Google Chrome/Local State')) {
        return true
      }
      if (p.endsWith('Google Chrome/Default/Network/Cookies')) {
        return false
      }
      if (p.endsWith('Google Chrome/Default/Cookies')) {
        return true
      }
      return false
    }

    const kept = filterChromiumCandidates(MACHINE_CANDIDATES, {
      appSupportRoot: APP_SUPPORT_ROOT,
      existsSync
    })

    expect(kept.map((c) => c.displayName).sort()).toEqual(['Aside', 'Comet', 'Google Chrome'])
    expect(kept.find((c) => c.displayName === 'iTerm')).toBeUndefined()
    expect(kept.find((c) => c.displayName === 'Safari')).toBeUndefined()
  })

  it('drops a candidate whose Local State exists but has no resolvable cookies DB', async () => {
    const { filterChromiumCandidates } = await import('./installed-browser-discovery')

    // Local State present, but neither cookies path resolves.
    const existsSync: ExistsSync = (rawPath) => slashPath(rawPath).endsWith('Comet/Local State')

    const kept = filterChromiumCandidates(MACHINE_CANDIDATES, {
      appSupportRoot: APP_SUPPORT_ROOT,
      existsSync
    })

    expect(kept.find((c) => c.displayName === 'Comet')).toBeUndefined()
  })
})

describe('firstChromiumProfileWithCookies — non-Default profiles', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  const DATA_DIR = `${APP_SUPPORT_ROOT}/Ghosty`

  it('selects a non-Default profile when Default has no cookies', async () => {
    const { firstChromiumProfileWithCookies } = await import('./installed-browser-discovery')
    const existsSync: ExistsSync = (rawPath) => {
      const p = slashPath(rawPath)
      if (p.endsWith('Ghosty/Local State')) {
        return true
      }
      // Only Profile 1 owns a cookies DB (legacy path); Default has none.
      return p.endsWith('Ghosty/Profile 1/Cookies')
    }
    const readFileSync: ReadTextFileSync = () =>
      JSON.stringify({
        profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } } }
      })

    const info = firstChromiumProfileWithCookies(DATA_DIR, { existsSync, readFileSync })

    expect(info?.selectedProfile).toBe('Profile 1')
    expect(info?.profiles.map((p) => p.directory).sort()).toEqual(['Default', 'Profile 1'])
    expect(slashPath(info?.cookiesPath ?? '')).toBe(
      '/Users/test/Library/Application Support/Ghosty/Profile 1/Cookies'
    )
  })

  it('returns null when the data dir has no Local State', async () => {
    const { firstChromiumProfileWithCookies } = await import('./installed-browser-discovery')
    const existsSync: ExistsSync = () => false
    expect(firstChromiumProfileWithCookies(DATA_DIR, { existsSync })).toBeNull()
  })

  it('returns null when no profile owns a cookies DB', async () => {
    const { firstChromiumProfileWithCookies } = await import('./installed-browser-discovery')
    const existsSync: ExistsSync = (rawPath) => slashPath(rawPath).endsWith('Ghosty/Local State')
    expect(firstChromiumProfileWithCookies(DATA_DIR, { existsSync })).toBeNull()
  })
})
