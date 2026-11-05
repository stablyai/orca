import { webContents } from 'electron'

/**
 * activeTab: invoking an extension on a tab (its action, one of its keyboard commands or context
 * menu items) lets it read that tab's URL and title until the tab loads another document or
 * closes, or the extension unloads, as Chrome grants it.
 * Orca's own APIs honor the grant too (tabs.captureVisibleTab). Script access does not follow:
 * Electron's native scripting.executeScript/insertCSS check only manifest host permissions, and
 * Electron has no API to add Chromium's per-tab grant, so those calls still fail with Chrome's
 * "Cannot access contents of the page" error. tabs.sendMessage needs no host access and works.
 */
const grantsByTabId = new Map<number, Set<string>>()

export function grantBrowserExtensionActiveTab(extension: Electron.Extension, tabId: number): void {
  const declared: unknown = extension.manifest?.permissions
  if (!Array.isArray(declared) || !declared.includes('activeTab')) {
    return
  }
  const grants = grantsByTabId.get(tabId) ?? new Set<string>()
  grants.add(extension.id)
  grantsByTabId.set(tabId, grants)
}

export function hasBrowserExtensionActiveTab(extensionId: string, tabId: number): boolean {
  return grantsByTabId.get(tabId)?.has(extensionId) === true
}

function originOf(url: string): string | null {
  try {
    const { origin } = new URL(url)
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/**
 * Host access an activeTab grant gives: the granted document's origin only (Chrome's
 * new_hosts.AddOrigin), never other hosts the tab requests. Any navigation revokes the grant, so the
 * tab's current URL is still the granted document's.
 */
export function browserExtensionActiveTabCovers(
  extensionId: string,
  tabId: number,
  url: string
): boolean {
  if (!hasBrowserExtensionActiveTab(extensionId, tabId)) {
    return false
  }
  const granted = originOf(webContents.fromId(tabId)?.getURL() ?? '')
  return granted !== null && originOf(url) === granted
}

export function revokeBrowserExtensionActiveTab(tabId: number): void {
  grantsByTabId.delete(tabId)
}

/** The extension unloaded from `sess`: its grants on that session's tabs end. */
export function revokeBrowserExtensionActiveTabInSession(
  sess: Electron.Session,
  extensionId: string
): void {
  for (const [tabId, grants] of grantsByTabId) {
    if (webContents.fromId(tabId)?.session === sess) {
      grants.delete(extensionId)
    }
  }
}
