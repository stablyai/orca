import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { resolveChromiumCookiesPath } from './chromium-cookie-path'
import {
  CHROMIUM_BROWSERS,
  browserRootPath,
  discoverProfiles,
  detectFirefox,
  firefoxProfilesRoot,
  isSafeBrowserProfileDirectory,
  type DetectedBrowser
} from './browser-cookie-detection-types'
import {
  discoverInstalledBrowsers,
  filterChromiumCandidates,
  firstChromiumProfileWithCookies,
  type DiscoveredBrowserCandidate
} from './installed-browser-discovery'
import { customBrowsersFromCandidates } from './custom-browser-detection'
import { queryHttpsHandlersMacOS } from './installed-browser-query-macos'

// ---------------------------------------------------------------------------
// Safari detection
// ---------------------------------------------------------------------------

export function detectSafari(): DetectedBrowser | null {
  if (process.platform !== 'darwin') {
    return null
  }
  const home = process.env.HOME ?? ''
  const candidates = [
    join(home, 'Library', 'Cookies', 'Cookies.binarycookies'),
    join(
      home,
      'Library',
      'Containers',
      'com.apple.Safari',
      'Data',
      'Library',
      'Cookies',
      'Cookies.binarycookies'
    )
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return {
        family: 'safari',
        label: 'Safari',
        cookiesPath: candidate,
        profiles: [{ name: 'Default', directory: 'Default' }],
        selectedProfile: 'Default'
      }
    }
  }
  return null
}

export function detectInstalledBrowsers(): DetectedBrowser[] {
  const detected: DetectedBrowser[] = []
  for (const browser of CHROMIUM_BROWSERS) {
    const root = browserRootPath(browser)
    if (!root) {
      continue
    }
    const profiles = discoverProfiles(root)
    // Why: a browser counts as detected once a profile has a cookies DB; use the first such profile as default.
    for (const profile of profiles) {
      const profileDir = join(root, profile.directory)
      const cookiesPath = resolveChromiumCookiesPath(profileDir)
      if (cookiesPath) {
        detected.push({
          family: browser.family,
          label: browser.label,
          keychainService: browser.keychainService,
          keychainAccount: browser.keychainAccount,
          cookiesPath,
          profiles,
          selectedProfile: profile.directory
        })
        break
      }
    }
  }

  const firefox = detectFirefox()
  if (firefox) {
    detected.push(firefox)
  }

  const safari = detectSafari()
  if (safari) {
    detected.push(safari)
  }

  return detected
}

// Why: env-gated e2e seam; ignored in packaged builds so a shipped app never
// honors ORCA_E2E_FAKE_HTTPS_HANDLERS — only unpackaged dev/e2e runs use it.
function resolveDefaultHttpsHandlersQuery(): () => Promise<DiscoveredBrowserCandidate[]> {
  const fake = app.isPackaged ? undefined : process.env.ORCA_E2E_FAKE_HTTPS_HANDLERS
  if (fake) {
    try {
      const parsed = JSON.parse(fake) as DiscoveredBrowserCandidate[]
      return () => Promise.resolve(parsed)
    } catch {
      // Bad env → ignore and fall back to the real OS query.
    }
  }
  return () => queryHttpsHandlersMacOS()
}

// Hardcoded detection plus macOS auto-discovery of installed Chromium browsers via the
// OS URL-handler query. Returns the hardcoded set unchanged on non-macOS.
export async function detectAllBrowsers(opts?: {
  queryHttpsHandlers?: () => Promise<DiscoveredBrowserCandidate[]>
}): Promise<DetectedBrowser[]> {
  const hardcoded = detectInstalledBrowsers()
  if (process.platform !== 'darwin') {
    return hardcoded
  }
  const appSupportRoot = join(process.env.HOME ?? '', 'Library', 'Application Support')
  const candidates = await discoverInstalledBrowsers({
    platform: process.platform,
    queryHttpsHandlers: opts?.queryHttpsHandlers ?? resolveDefaultHttpsHandlersQuery()
  })
  const chromium = filterChromiumCandidates(candidates, { appSupportRoot })
  // Hardcoded roots let the resolution ladder drop already-known browsers (dedup).
  const knownBrowsers = CHROMIUM_BROWSERS.flatMap((def) => {
    const root = browserRootPath(def)
    return root
      ? [
          {
            family: def.family,
            label: def.label,
            dataDir: root,
            keychainService: def.keychainService,
            keychainAccount: def.keychainAccount
          }
        ]
      : []
  })
  const customs = customBrowsersFromCandidates(chromium, {
    knownBrowsers,
    appSupportRoot,
    existsSync,
    profilesFor: (dataDir) => firstChromiumProfileWithCookies(dataDir, { existsSync, readFileSync })
  })
  // Why: dedup by cookies DB path so two discovered browsers resolving to the same
  // store never appear twice (hardcoded-vs-discovered is already dropped upstream).
  const seenCookies = new Set<string>()
  return [...hardcoded, ...customs].filter((browser) => {
    if (seenCookies.has(browser.cookiesPath)) {
      return false
    }
    seenCookies.add(browser.cookiesPath)
    return true
  })
}

// Derive a custom browser's data root from its cookies path + selected profile:
// <root>/<selectedProfile>/Cookies or <root>/<selectedProfile>/Network/Cookies.
// Why the 'Network' check is unambiguous: Chromium never names a profile dir 'Network'
// (it's a reserved sub-folder), so a 'Network' path segment is always the DB sub-dir.
function customBrowserRoot(browser: DetectedBrowser): string | null {
  let profileDir = dirname(browser.cookiesPath)
  if (basename(profileDir) === 'Network') {
    profileDir = dirname(profileDir)
  }
  if (basename(profileDir) !== browser.selectedProfile) {
    return null
  }
  return dirname(profileDir)
}

export function selectBrowserProfile(
  browser: DetectedBrowser,
  profileDirectory: string
): DetectedBrowser | null {
  if (!isSafeBrowserProfileDirectory(profileDirectory)) {
    return null
  }
  if (browser.family === 'firefox') {
    const profilesRoot = firefoxProfilesRoot()
    if (!profilesRoot) {
      return null
    }
    const cookiesPath = join(profilesRoot, profileDirectory, 'cookies.sqlite')
    if (!existsSync(cookiesPath)) {
      return null
    }
    return { ...browser, cookiesPath, selectedProfile: profileDirectory }
  }

  if (browser.family === 'custom') {
    const customRoot = customBrowserRoot(browser)
    if (!customRoot) {
      return null
    }
    const customCookiesPath = resolveChromiumCookiesPath(join(customRoot, profileDirectory))
    if (!customCookiesPath) {
      return null
    }
    return { ...browser, cookiesPath: customCookiesPath, selectedProfile: profileDirectory }
  }

  const browserDef = CHROMIUM_BROWSERS.find((b) => b.family === browser.family)
  if (!browserDef) {
    return null
  }
  const root = browserRootPath(browserDef)
  if (!root) {
    return null
  }
  const profileDir = join(root, profileDirectory)
  const cookiesPath = resolveChromiumCookiesPath(profileDir)
  if (!cookiesPath) {
    return null
  }
  return {
    ...browser,
    cookiesPath,
    selectedProfile: profileDirectory
  }
}
