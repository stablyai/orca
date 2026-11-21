import { getChromeExtensionOrigin } from '../../../../shared/browser/extensions/browser-extension-url'
import { BrowserExtensionApiError } from '../api-runtime/browser-extension-namespace-registry'
import { getBrowserExtensionProfileStateStore } from '../profile-storage/browser-extension-profile-state-store'

export type BrowserExtensionSidePanelOptions = {
  /** Relative to the extension root; absent until the manifest or setOptions names a page. */
  path?: string
  enabled: boolean
}

type ExtensionOptions = {
  global: BrowserExtensionSidePanelOptions | null
  tabs: Map<number, BrowserExtensionSidePanelOptions>
}

// Why memory only: Chrome forgets setOptions when the extension unloads or the browser restarts.
// Why by profile first: a tab closing touches only its own profile's extensions.
const optionsByProfile = new Map<string, Map<string, ExtensionOptions>>()

function optionsFor(profileId: string, extensionId: string): ExtensionOptions | undefined {
  return optionsByProfile.get(profileId)?.get(extensionId)
}

function manifestOptions(extension: Electron.Extension): BrowserExtensionSidePanelOptions | null {
  const sidePanel: unknown = extension.manifest?.side_panel
  const path =
    typeof sidePanel === 'object' && sidePanel !== null && 'default_path' in sidePanel
      ? sidePanel.default_path
      : undefined
  return typeof path === 'string' && path !== ''
    ? { path: normalizeSidePanelPath(extension.id, path), enabled: true }
    : null
}

/** A page of this extension, kept root-relative like the manifest's default_path. */
export function normalizeSidePanelPath(extensionId: string, path: string): string {
  const origin = `${getChromeExtensionOrigin(extensionId)}/`
  const url = new URL(path, origin)
  if (!url.href.startsWith(origin)) {
    throw new BrowserExtensionApiError('The side panel must be a page of this extension')
  }
  return url.pathname.slice(1) + url.search + url.hash
}

export function getSidePanelGlobalOptions(
  profileId: string,
  extension: Electron.Extension
): BrowserExtensionSidePanelOptions | null {
  return optionsFor(profileId, extension.id)?.global ?? manifestOptions(extension)
}

export function getSidePanelTabOptions(
  profileId: string,
  extensionId: string,
  tabId: number
): BrowserExtensionSidePanelOptions | null {
  return optionsFor(profileId, extensionId)?.tabs.get(tabId) ?? null
}

/** What applies on a tab: its own options, else the global ones (Chrome's getOptions order). */
export function getSidePanelOptionsForTab(
  profileId: string,
  extension: Electron.Extension,
  tabId: number | null
): BrowserExtensionSidePanelOptions | null {
  return (
    (tabId === null ? null : getSidePanelTabOptions(profileId, extension.id, tabId)) ??
    getSidePanelGlobalOptions(profileId, extension)
  )
}

export function isUsableSidePanel(
  options: BrowserExtensionSidePanelOptions | null
): options is BrowserExtensionSidePanelOptions & { path: string } {
  return Boolean(options?.enabled && options.path)
}

/** Tabs that have options of their own, where the global panel never shows. */
export function listSidePanelTabsWithOwnOptions(profileId: string, extensionId: string): number[] {
  return [...(optionsFor(profileId, extensionId)?.tabs.keys() ?? [])]
}

/**
 * setOptions merges into what was set before. A tab's first options start from `enabled: true`
 * and no page (Chrome does not inherit the global page); the first global ones start from the
 * manifest.
 */
export function setSidePanelOptions(
  profileId: string,
  extension: Electron.Extension,
  change: { tabId?: number; path?: string; enabled?: boolean }
): BrowserExtensionSidePanelOptions {
  const byExtension = optionsByProfile.get(profileId) ?? new Map<string, ExtensionOptions>()
  optionsByProfile.set(profileId, byExtension)
  const entry = byExtension.get(extension.id) ?? { global: null, tabs: new Map() }
  byExtension.set(extension.id, entry)
  const previous =
    change.tabId === undefined
      ? (entry.global ?? manifestOptions(extension))
      : entry.tabs.get(change.tabId)
  const path = change.path === undefined ? previous?.path : change.path
  const next: BrowserExtensionSidePanelOptions = {
    ...(path === undefined ? {} : { path }),
    enabled: change.enabled ?? previous?.enabled ?? true
  }
  if (change.tabId === undefined) {
    entry.global = next
  } else {
    entry.tabs.set(change.tabId, next)
  }
  return next
}

/** True when some extension had options for the tab (a global panel may show there again). */
export function forgetSidePanelTabOptions(profileId: string, tabId: number): boolean {
  let forgot = false
  for (const entry of optionsByProfile.get(profileId)?.values() ?? []) {
    forgot = entry.tabs.delete(tabId) || forgot
  }
  return forgot
}

export function forgetSidePanelExtensionOptions(profileId: string, extensionId: string): void {
  const byExtension = optionsByProfile.get(profileId)
  byExtension?.delete(extensionId)
  if (byExtension?.size === 0) {
    optionsByProfile.delete(profileId)
  }
}

export function getOpenSidePanelOnActionClick(profileId: string, extensionId: string): boolean {
  return (
    getBrowserExtensionProfileStateStore().read(profileId, extensionId)
      .openSidePanelOnActionClick === true
  )
}

export function setOpenSidePanelOnActionClick(
  profileId: string,
  extensionId: string,
  value: boolean
): void {
  getBrowserExtensionProfileStateStore().update(profileId, extensionId, (state) => ({
    ...state,
    openSidePanelOnActionClick: value
  }))
}
