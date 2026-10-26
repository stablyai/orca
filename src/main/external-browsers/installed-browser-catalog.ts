import type { InstalledBrowser } from '../../shared/external-browser-types'
import { readLinuxInstalledBrowsers } from './linux-installed-browsers'
import { readMacInstalledBrowsers } from './mac-installed-browsers'
import { readWindowsInstalledBrowsers } from './windows-installed-browsers'

export type BrowserLaunchCommand = {
  program: string
  args: string[]
  /** The launcher exits after handing off, so its exit code reports success. */
  waitForExit?: boolean
}

export type DetectedBrowser = InstalledBrowser & {
  launchCommand: (url: string) => BrowserLaunchCommand
}

// Short TTL keeps menus fresh while still noticing installs and uninstalls.
const CATALOG_CACHE_TTL_MS = 30_000

/** The last completed scan; readers never wait on a rescan once one exists. */
let snapshot: { readAt: number; browsers: DetectedBrowser[] } | undefined
let pendingScan: Promise<DetectedBrowser[]> | undefined

function readPlatformBrowsers(): Promise<DetectedBrowser[]> {
  if (process.platform === 'darwin') {
    return readMacInstalledBrowsers()
  }
  if (process.platform === 'win32') {
    return readWindowsInstalledBrowsers()
  }
  if (process.platform === 'linux') {
    return readLinuxInstalledBrowsers()
  }
  return Promise.resolve([])
}

function scanBrowsers(): Promise<DetectedBrowser[]> {
  pendingScan ??= readPlatformBrowsers()
    .catch(() => [])
    .then((browsers) => {
      snapshot = { readAt: Date.now(), browsers }
      pendingScan = undefined
      return browsers
    })
  return pendingScan
}

/** The last completed scan without waiting, empty before the first; starts a rescan when stale. */
function readDetectedBrowserSnapshot(): DetectedBrowser[] {
  if (!snapshot || Date.now() - snapshot.readAt >= CATALOG_CACHE_TTL_MS) {
    void scanBrowsers()
  }
  return snapshot?.browsers ?? []
}

function toInstalledBrowsers(browsers: readonly DetectedBrowser[]): InstalledBrowser[] {
  return browsers.map(({ id, name }) => ({ id, name }))
}

export function readInstalledBrowserSnapshot(): InstalledBrowser[] {
  return toInstalledBrowsers(readDetectedBrowserSnapshot())
}

/** Waits only for a forced rescan or the very first scan; otherwise answers from the snapshot. */
export async function listInstalledBrowsers(
  options: { forceRefresh?: boolean } = {}
): Promise<InstalledBrowser[]> {
  const browsers =
    options.forceRefresh || !snapshot ? await scanBrowsers() : readDetectedBrowserSnapshot()
  return toInstalledBrowsers(browsers)
}

export async function findInstalledBrowser(id: string): Promise<DetectedBrowser | undefined> {
  const cached = readDetectedBrowserSnapshot().find((browser) => browser.id === id)
  if (cached || !pendingScan) {
    return cached
  }
  // A miss waits only on an in-flight scan, so a missing id rescans at most once per TTL.
  return (await pendingScan).find((browser) => browser.id === id)
}
