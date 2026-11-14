/// <reference types="chrome" />
import type { BrowserExtensionTabEntry } from './browser-extension-tab-model'
import { getBrowserExtensionDocumentId } from './browser-extension-document-ids'
import { getChromeExtensionOrigin } from '../../../../shared/browser/extensions/browser-extension-url'
import { extensionHasPermission } from '../api-runtime/browser-extension-namespace-registry'
import { hasBrowserExtensionHostPermission } from '../permissions/browser-extension-permission-grants'
import { browserExtensionHostPatternsInSession } from '../permissions/browser-extension-session-permissions'
import { hasBrowserExtensionActiveTab } from '../permissions/browser-extension-active-tab'

/** Chrome shows url/title with "tabs" or a matching host permission, optional grants included. */
export function canExtensionSeeTabUrl(
  extension: Electron.Extension,
  sess: Electron.Session,
  url: string,
  tabId?: number
): boolean {
  return (
    url.startsWith(`${getChromeExtensionOrigin(extension.id)}/`) ||
    extensionHasPermission(extension, 'tabs', sess) ||
    (tabId !== undefined && hasBrowserExtensionActiveTab(extension.id, tabId)) ||
    hasBrowserExtensionHostPermission(browserExtensionHostPatternsInSession(extension, sess), url)
  )
}

/** The fields Orca owns; url/title come from Electron's native result or describeBrowserExtensionTab. */
function orcaTabFields(entry: BrowserExtensionTabEntry): chrome.tabs.Tab {
  const { contents } = entry
  return {
    id: contents.id,
    index: entry.index,
    windowId: entry.windowId,
    active: entry.active,
    highlighted: entry.active,
    selected: entry.active,
    pinned: false,
    discarded: false,
    autoDiscardable: true,
    incognito: false,
    groupId: -1,
    status: contents.isLoading() ? 'loading' : 'complete',
    audible: contents.isCurrentlyAudible(),
    mutedInfo: { muted: contents.isAudioMuted() }
  }
}

/** Historical events recheck today's grants against the original document, never its successor. */
export function snapshotBrowserExtensionTab(
  entry: BrowserExtensionTabEntry
): (extension: Electron.Extension) => chrome.tabs.Tab {
  const { contents } = entry
  const fields = orcaTabFields(entry)
  const url = contents.getURL()
  const title = contents.getTitle()
  const session = contents.session
  const documentId = getBrowserExtensionDocumentId(contents.mainFrame)
  return (extension) => {
    const sameDocument =
      !contents.isDestroyed() && getBrowserExtensionDocumentId(contents.mainFrame) === documentId
    return {
      ...fields,
      ...(canExtensionSeeTabUrl(extension, session, url, sameDocument ? fields.id : undefined)
        ? { url, title }
        : {})
    }
  }
}

export function describeBrowserExtensionTab(
  extension: Electron.Extension,
  entry: BrowserExtensionTabEntry
): chrome.tabs.Tab {
  const url = entry.contents.getURL()
  return {
    ...orcaTabFields(entry),
    ...(canExtensionSeeTabUrl(extension, entry.contents.session, url, entry.contents.id)
      ? { url, title: entry.contents.getTitle() }
      : {})
  }
}

/** Keeps Electron's native fields (url/title gated by its own permission check) and adds Orca's. */
export function mergeNativeTab(
  nativeTab: Record<string, unknown>,
  entry: BrowserExtensionTabEntry
): chrome.tabs.Tab {
  const native: Partial<chrome.tabs.Tab> = {}
  for (const key of [
    'url',
    'title',
    'favIconUrl',
    'lastAccessed',
    'audible',
    'mutedInfo'
  ] as const) {
    if (nativeTab[key] !== undefined) {
      Object.assign(native, { [key]: nativeTab[key] })
    }
  }
  return { ...orcaTabFields(entry), ...native }
}
