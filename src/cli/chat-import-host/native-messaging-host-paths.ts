import { join } from 'node:path'
import type { InstallBrowser } from './install-native-messaging-host'
import { NATIVE_MESSAGING_HOST_NAME } from './native-messaging-manifest'

// Per-browser NativeMessagingHosts / user-data directory, relative to the
// OS config root. Shared by the installer and (later) the settings status
// check, so both derive the same paths from a single source.
const BROWSER_DIR: Record<InstallBrowser, { darwin: string[]; linux: string[]; win: string[] }> = {
  chrome: {
    darwin: ['Google', 'Chrome'],
    linux: ['google-chrome'],
    win: ['Google', 'Chrome', 'User Data']
  },
  edge: {
    darwin: ['Microsoft Edge'],
    linux: ['microsoft-edge'],
    win: ['Microsoft', 'Edge', 'User Data']
  },
  brave: {
    darwin: ['BraveSoftware', 'Brave-Browser'],
    linux: ['BraveSoftware', 'Brave-Browser'],
    win: ['BraveSoftware', 'Brave-Browser', 'User Data']
  },
  chromium: { darwin: ['Chromium'], linux: ['chromium'], win: ['Chromium', 'User Data'] }
}

// Per-browser registry hive under HKCU, mirroring BROWSER_DIR for Windows —
// each Chromium-based browser reads NativeMessagingHosts from its own hive.
const WINDOWS_REGISTRY_BASE: Record<InstallBrowser, string> = {
  chrome: 'Software\\Google\\Chrome',
  edge: 'Software\\Microsoft\\Edge',
  brave: 'Software\\BraveSoftware\\Brave-Browser',
  chromium: 'Software\\Chromium'
}

function hostDir(browser: InstallBrowser, platform: NodeJS.Platform, homeDir: string): string {
  const seg = BROWSER_DIR[browser]
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', ...seg.darwin, 'NativeMessagingHosts')
  }
  // linux
  return join(homeDir, '.config', ...seg.linux, 'NativeMessagingHosts')
}

export function nativeMessagingManifestPath(a: {
  browser: InstallBrowser
  platform: NodeJS.Platform
  homeDir: string
  userDataPath: string
}): string {
  if (a.platform === 'win32') {
    return join(a.userDataPath, 'chat-import', `${NATIVE_MESSAGING_HOST_NAME}.json`)
  }
  return join(hostDir(a.browser, a.platform, a.homeDir), `${NATIVE_MESSAGING_HOST_NAME}.json`)
}

function localAppData(homeDir: string): string {
  return process.env.LOCALAPPDATA ?? join(homeDir, 'AppData', 'Local')
}

// Detection-only: where a browser stores its profile data, used by the
// settings status check to tell whether the browser itself is installed.
export function browserUserDataDir(a: {
  browser: InstallBrowser
  platform: NodeJS.Platform
  homeDir: string
}): string {
  const seg = BROWSER_DIR[a.browser]
  if (a.platform === 'darwin') {
    return join(a.homeDir, 'Library', 'Application Support', ...seg.darwin)
  }
  if (a.platform === 'win32') {
    return join(localAppData(a.homeDir), ...seg.win)
  }
  return join(a.homeDir, '.config', ...seg.linux)
}

export function windowsRegistryHostKey(browser: InstallBrowser): string {
  return `${WINDOWS_REGISTRY_BASE[browser]}\\NativeMessagingHosts\\${NATIVE_MESSAGING_HOST_NAME}`
}
