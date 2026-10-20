/**
 * activeTab: invoking an extension's action (click, popup, keyboard command) lets it read that
 * tab's URL and title until the tab loads another document or closes, as Chrome grants it.
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

export function revokeBrowserExtensionActiveTab(tabId: number): void {
  grantsByTabId.delete(tabId)
}
