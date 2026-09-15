import type { DetectedBrowser } from './browser-cookie-import'
import type {
  ChromiumProfilesWithCookies,
  DiscoveredBrowserCandidate,
  ExistsSync
} from './installed-browser-discovery'
import { resolveBrowserCandidate, type KnownBrowserEntry } from './chromium-browser-resolution'

// Turn OS-discovered candidates into custom DetectedBrowser entries. Candidates that
// resolve to a maintained hardcoded entry (known) or can't be resolved (needs-setup)
// are dropped here — knowns are already in the hardcoded list, so this is the dedup.
// A candidate whose data dir owns no profile with cookies (profilesFor === null) is
// also dropped, so non-Default profiles are honored via the injected resolver.
export function customBrowsersFromCandidates(
  candidates: DiscoveredBrowserCandidate[],
  opts: {
    knownBrowsers: KnownBrowserEntry[]
    appSupportRoot: string
    existsSync: ExistsSync
    profilesFor: (dataDir: string) => ChromiumProfilesWithCookies | null
  }
): DetectedBrowser[] {
  const result: DetectedBrowser[] = []
  for (const candidate of candidates) {
    const resolution = resolveBrowserCandidate(candidate, {
      knownBrowsers: opts.knownBrowsers,
      appSupportRoot: opts.appSupportRoot,
      existsSync: opts.existsSync
    })
    if (resolution.status !== 'resolved' || resolution.browser.family !== 'custom') {
      continue
    }
    const browser = resolution.browser
    const profileInfo = opts.profilesFor(browser.dataDir)
    if (!profileInfo) {
      continue
    }
    result.push({
      family: 'custom',
      label: browser.label,
      cookiesPath: profileInfo.cookiesPath,
      keychainService: browser.keychainService,
      keychainAccount: browser.keychainAccount,
      profiles: profileInfo.profiles,
      selectedProfile: profileInfo.selectedProfile,
      customBrowserId: browser.customBrowserId
    })
  }
  return result
}
