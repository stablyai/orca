import type { DetectedBrowser } from './browser-cookie-import'
import type { DiscoveredBrowserCandidate } from './installed-browser-discovery'
import { resolveBrowserCandidate, type KnownBrowserEntry } from './chromium-browser-resolution'

// Turn OS-discovered candidates into custom DetectedBrowser entries. Candidates that
// resolve to a maintained hardcoded entry (known) or can't be resolved (needs-setup)
// are dropped here — knowns are already in the hardcoded list, so this is the dedup.
export function customBrowsersFromCandidates(
  candidates: DiscoveredBrowserCandidate[],
  opts: {
    knownBrowsers: KnownBrowserEntry[]
    appSupportRoot: string
    existsSync: (path: string) => boolean
    cookiesPathFor: (dataDir: string) => string
  }
): DetectedBrowser[] {
  const result: DetectedBrowser[] = []
  for (const candidate of candidates) {
    const resolution = resolveBrowserCandidate(candidate, {
      knownBrowsers: opts.knownBrowsers,
      appSupportRoot: opts.appSupportRoot,
      existsSync: opts.existsSync as never
    })
    if (resolution.status !== 'resolved' || resolution.browser.family !== 'custom') {
      continue
    }
    const browser = resolution.browser
    result.push({
      family: 'custom',
      label: browser.label,
      cookiesPath: opts.cookiesPathFor(browser.dataDir),
      keychainService: browser.keychainService,
      keychainAccount: browser.keychainAccount,
      profiles: [{ name: 'Default', directory: 'Default' }],
      selectedProfile: 'Default',
      customBrowserId: browser.customBrowserId
    })
  }
  return result
}
