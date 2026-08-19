import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredBrowserCandidate } from './installed-browser-discovery'

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
  { bundleId: 'company.thebrowser.aside', displayName: 'Aside', appPath: '/Applications/Aside.app' },
  { bundleId: 'com.apple.Safari', displayName: 'Safari', appPath: '/Applications/Safari.app' },
  { bundleId: 'com.google.Chrome', displayName: 'Google Chrome', appPath: '/Applications/Google Chrome.app' },
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
    const existsSync = ((rawPath: import('node:fs').PathLike): boolean => {
      const p = slashPath(String(rawPath))
      if (p.endsWith('Aside/Local State')) return true
      if (p.endsWith('Aside/Default/Network/Cookies')) return true
      if (p.endsWith('Comet/Local State')) return true
      if (p.endsWith('Comet/Default/Network/Cookies')) return true
      if (p.endsWith('Google Chrome/Local State')) return true
      if (p.endsWith('Google Chrome/Default/Network/Cookies')) return false
      if (p.endsWith('Google Chrome/Default/Cookies')) return true
      return false
    }) as typeof import('node:fs').existsSync

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

    const existsSync = ((rawPath: import('node:fs').PathLike): boolean => {
      const p = slashPath(String(rawPath))
      // Local State present, but neither cookies path resolves.
      return p.endsWith('Comet/Local State')
    }) as typeof import('node:fs').existsSync

    const kept = filterChromiumCandidates(MACHINE_CANDIDATES, {
      appSupportRoot: APP_SUPPORT_ROOT,
      existsSync
    })

    expect(kept.find((c) => c.displayName === 'Comet')).toBeUndefined()
  })
})
