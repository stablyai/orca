import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
