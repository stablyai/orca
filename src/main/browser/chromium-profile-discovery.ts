import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserSessionProfileSource } from '../../shared/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BrowserProfile = {
  name: string
  directory: string
}

export type ChromiumBrowserDef = {
  family: BrowserSessionProfileSource['browserFamily']
  label: string
  keychainService: string
  keychainAccount: string
  // Why: each platform stores browser data in a different location. The per-platform
  // root paths are resolved at detection time via browserRootPath().
  macRoot?: string
  winRoot?: string
  linuxRoot?: string
}

export type DetectedChromiumBrowser = {
  family: BrowserSessionProfileSource['browserFamily']
  label: string
  root: string
  keychainService?: string
  keychainAccount?: string
  profiles: BrowserProfile[]
  selectedProfile: string
}

// ---------------------------------------------------------------------------
// Browser table
// ---------------------------------------------------------------------------

export const CHROMIUM_BROWSERS: ChromiumBrowserDef[] = [
  {
    family: 'chrome',
    label: 'Google Chrome',
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    macRoot: 'Google/Chrome',
    winRoot: 'Google/Chrome/User Data',
    linuxRoot: 'google-chrome'
  },
  {
    family: 'edge',
    label: 'Microsoft Edge',
    keychainService: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge',
    macRoot: 'Microsoft Edge',
    winRoot: 'Microsoft/Edge/User Data',
    linuxRoot: 'microsoft-edge'
  },
  {
    family: 'arc',
    label: 'Arc',
    keychainService: 'Arc Safe Storage',
    keychainAccount: 'Arc',
    macRoot: 'Arc/User Data'
  },
  {
    family: 'chromium',
    label: 'Brave',
    keychainService: 'Brave Safe Storage',
    keychainAccount: 'Brave',
    macRoot: 'BraveSoftware/Brave-Browser',
    winRoot: 'BraveSoftware/Brave-Browser/User Data',
    linuxRoot: 'BraveSoftware/Brave-Browser'
  },
  {
    family: 'comet',
    label: 'Comet',
    keychainService: 'Comet Safe Storage',
    keychainAccount: 'Comet',
    macRoot: 'Comet',
    winRoot: 'Comet/User Data'
    // linuxRoot intentionally omitted — Comet does not ship a Linux build as of 2026-05-15
  }
]

// ---------------------------------------------------------------------------
// Root path resolution
// ---------------------------------------------------------------------------

export function browserRootPath(def: ChromiumBrowserDef): string | null {
  if (process.platform === 'darwin') {
    if (!def.macRoot) {
      return null
    }
    const home = process.env.HOME ?? ''
    return join(home, 'Library', 'Application Support', def.macRoot)
  }
  if (process.platform === 'win32') {
    if (!def.winRoot) {
      return null
    }
    const localAppData = process.env.LOCALAPPDATA ?? ''
    if (!localAppData) {
      return null
    }
    return join(localAppData, def.winRoot)
  }
  // Linux
  if (!def.linuxRoot) {
    return null
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config')
  return join(configHome, def.linuxRoot)
}

// ---------------------------------------------------------------------------
// Profile safety guard
// ---------------------------------------------------------------------------

export function isSafeBrowserProfileDirectory(directory: string): boolean {
  return (
    directory.length > 0 &&
    directory !== '.' &&
    !directory.includes('\0') &&
    !directory.includes('/') &&
    !directory.includes('\\') &&
    !directory.includes('..')
  )
}

// ---------------------------------------------------------------------------
// Profile discovery
// ---------------------------------------------------------------------------

// Why: Chrome's Local State JSON contains profile.info_cache which maps profile
// directory names (e.g. "Default", "Profile 1") to metadata including the
// user-visible display name. This lets us show human-readable names in the picker.
export function discoverProfiles(browserRoot: string): BrowserProfile[] {
  try {
    const localStatePath = join(browserRoot, 'Local State')
    if (!existsSync(localStatePath)) {
      return [{ name: 'Default', directory: 'Default' }]
    }
    const raw = readFileSync(localStatePath, 'utf-8')
    const localState = JSON.parse(raw)
    const infoCache = localState?.profile?.info_cache
    if (!infoCache || typeof infoCache !== 'object') {
      return [{ name: 'Default', directory: 'Default' }]
    }
    const profiles: BrowserProfile[] = []
    for (const [dir, info] of Object.entries(infoCache)) {
      // Why: Local State is external metadata, but profile dirs become path segments.
      if (!isSafeBrowserProfileDirectory(dir)) {
        continue
      }
      const profileName = (info as { name?: string })?.name ?? dir
      profiles.push({ name: profileName, directory: dir })
    }
    return profiles.length > 0 ? profiles : [{ name: 'Default', directory: 'Default' }]
  } catch {
    return [{ name: 'Default', directory: 'Default' }]
  }
}

// ---------------------------------------------------------------------------
// Store-agnostic Chromium browser detection
// ---------------------------------------------------------------------------

// Why: abstracting the store path resolution out of detection lets password
// import reuse the same browser enumeration loop with a "Login Data" resolver
// instead of cookies. The caller decides which file makes a browser "installed."
export function detectChromiumBrowsers(
  resolveStorePath: (root: string, profileDir: string) => string | null
): DetectedChromiumBrowser[] {
  const detected: DetectedChromiumBrowser[] = []

  for (const browser of CHROMIUM_BROWSERS) {
    const root = browserRootPath(browser)
    if (!root) {
      continue
    }
    const profiles = discoverProfiles(root)
    // Why: a browser is "detected" if at least one profile has the requested store file.
    // Use the first profile with a valid store path as the default selection.
    for (const profile of profiles) {
      const storePath = resolveStorePath(root, profile.directory)
      if (storePath) {
        detected.push({
          family: browser.family,
          label: browser.label,
          root,
          keychainService: browser.keychainService,
          keychainAccount: browser.keychainAccount,
          profiles,
          selectedProfile: profile.directory
        })
        break
      }
    }
  }

  return detected
}
