import {
  browserCookieImportFailure,
  type BrowserCookieImportFailure
} from '../../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import type {
  BrowserCookieImportSelection,
  BrowserSessionProfileSource
} from '../../../../shared/browser/workspaces/browser-workspace-types'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveChromiumCookiesPath } from '../chromium/chromium-cookie-path'
import {
  CHROMIUM_BROWSERS,
  browserRootPath,
  discoverListedChromiumProfiles,
  detectFirefox,
  firefoxProfilesRoot,
  isSafeBrowserProfileDirectory,
  type DetectedBrowser
} from './browser-cookie-source-profiles'

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

export function detectInstalledBrowsers(family?: string): DetectedBrowser[] {
  const detected: DetectedBrowser[] = []
  for (const browser of CHROMIUM_BROWSERS) {
    if (family && browser.family !== family) {
      continue
    }
    const root = browserRootPath(browser)
    if (!root) {
      continue
    }
    const listed = discoverListedChromiumProfiles(root)
    const profiles = listed.length ? listed : [{ name: 'Default', directory: 'Default' }]
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
          profilesFromLocalState: listed.length > 0,
          selectedProfile: profile.directory
        })
        break
      }
    }
  }

  const firefox = !family || family === 'firefox' ? detectFirefox() : null
  if (firefox) {
    detected.push(firefox)
  }

  const safari = !family || family === 'safari' ? detectSafari() : null
  if (safari) {
    detected.push(safari)
  }

  return detected
}

type BrowserImportProfile = {
  browserFamily: string
  browserProfile?: string
  refresh?: true
}

export function resolveBrowserImportSelection(
  selection: BrowserCookieImportSelection,
  previous: BrowserSessionProfileSource | null | undefined
): BrowserImportProfile | BrowserCookieImportFailure {
  if ('refreshSourceId' in selection) {
    const saved = previous?.browserFamily === 'chrome' ? previous.chromeProfile : undefined
    if (
      !saved?.id ||
      saved.id !== selection.refreshSourceId ||
      !isSafeBrowserProfileDirectory(saved.directory)
    ) {
      return browserCookieImportFailure('savedChromeProfileUnavailable')
    }
    return { browserFamily: 'chrome', browserProfile: saved.directory, refresh: true }
  }
  if (selection.browserProfile && !isSafeBrowserProfileDirectory(selection.browserProfile)) {
    return browserCookieImportFailure('invalidBrowserProfile')
  }
  if (!selection.browserFamily) {
    return browserCookieImportFailure('browserNotFound')
  }
  return selection
}

export function selectBrowserProfile(
  browser: DetectedBrowser | undefined,
  selection: BrowserImportProfile
): DetectedBrowser | BrowserCookieImportFailure {
  const directory = selection.browserProfile
  if (directory && !isSafeBrowserProfileDirectory(directory)) {
    return browserCookieImportFailure('invalidBrowserProfile')
  }
  if (
    selection.refresh &&
    (!browser?.profilesFromLocalState ||
      !browser.profiles.some((profile) => profile.directory === directory))
  ) {
    return browserCookieImportFailure('savedChromeProfileUnavailable')
  }
  if (!browser) {
    return browserCookieImportFailure('browserNotFound')
  }
  if (!directory || directory === browser.selectedProfile) {
    return browser
  }

  let cookiesPath: string | null = null
  if (browser.family === 'firefox') {
    const root = firefoxProfilesRoot()
    const path = root && join(root, directory, 'cookies.sqlite')
    if (path && existsSync(path)) {
      cookiesPath = path
    }
  } else {
    const def = CHROMIUM_BROWSERS.find((candidate) => candidate.family === browser.family)
    const root = def && browserRootPath(def)
    if (root) {
      cookiesPath = resolveChromiumCookiesPath(join(root, directory))
    }
  }
  if (!cookiesPath) {
    return selection.refresh
      ? browserCookieImportFailure('savedChromeProfileUnavailable')
      : browserCookieImportFailure('browserProfileDatabaseMissing', { profile: directory })
  }
  return { ...browser, cookiesPath, selectedProfile: directory }
}
