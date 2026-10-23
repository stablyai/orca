/// <reference types="chrome" />
import { z } from 'zod'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  type BrowserExtensionCaller,
  type BrowserExtensionMethod
} from '../browser-extension-namespace-registry'
import {
  describeBrowserExtensionTab,
  listBrowserExtensionTabs,
  requireCallerTab,
  resolveCallerWindowId,
  type BrowserExtensionTabEntry
} from '../browser-extension-tab-model'
import {
  describeBrowserExtensionDiscardedTab,
  findBrowserExtensionDiscardedTab
} from '../browser-extension-discarded-tab-model'

const tabIdSchema = z.number().int().nonnegative()
const optionalTabId = z.tuple([tabIdSchema.nullable().optional()])
const moveSchema = z
  .object({ index: z.number().int(), windowId: z.number().int() })
  .partial({ windowId: true })
  .loose()

// Why its own world: the page's main world must never see (or tamper with) Orca's reads.
const DETECT_LANGUAGE_WORLD_ID = 1_998
const READ_LANG_SCRIPT = "document.documentElement ? document.documentElement.lang : ''"

/** Chrome's default tab: the active one in the caller's current window. */
function requireTabOrActive(
  caller: BrowserExtensionCaller,
  tabId: number | null | undefined
): BrowserExtensionTabEntry {
  if (tabId != null) {
    return requireCallerTab(caller, tabId)
  }
  const windowId = resolveCallerWindowId(caller)
  const active = listBrowserExtensionTabs(caller.session).find(
    (entry) => entry.active && entry.windowId === windowId
  )
  if (!active) {
    throw new BrowserExtensionApiError('No active tab')
  }
  return active
}

function goInHistory(
  caller: BrowserExtensionCaller,
  tabId: number | null | undefined,
  back: boolean
) {
  const history = requireTabOrActive(caller, tabId).contents.navigationHistory
  if (back ? !history.canGoBack() : !history.canGoForward()) {
    throw new BrowserExtensionApiError('Cannot find a next page in history.')
  }
  if (back) {
    history.goBack()
  } else {
    history.goForward()
  }
}

/** A BCP 47 tag's language, as Chrome's detector names it; 'und' when the page names none. */
function languageFromLangAttribute(lang: unknown): string {
  const primary = typeof lang === 'string' ? lang.trim().split(/[-_]/)[0].toLowerCase() : ''
  return /^[a-z]{2,3}$/.test(primary) ? primary : 'und'
}

/**
 * Small tabs methods Orca answers without a Chrome equivalent underneath: tab order, discarding
 * and language detection are approximations (see each), history navigation is real.
 */
export const tabsPageMethods: Record<string, BrowserExtensionMethod> = {
  goBack: defineBrowserExtensionMethod(optionalTabId, (caller, tabId) =>
    goInHistory(caller, tabId, true)
  ),
  goForward: defineBrowserExtensionMethod(optionalTabId, (caller, tabId) =>
    goInHistory(caller, tabId, false)
  ),
  // Why unchanged: Orca's tab order lives in the renderer's workspace model, which main cannot reorder.
  move: defineBrowserExtensionMethod(
    z.tuple([z.union([tabIdSchema, z.array(tabIdSchema)]), moveSchema]),
    (caller, tabIds) => {
      const describe = (id: number): chrome.tabs.Tab =>
        describeBrowserExtensionTab(caller.extension, requireCallerTab(caller, id))
      return Array.isArray(tabIds) ? tabIds.map(describe) : describe(tabIds)
    }
  ),
  // Why a loaded tab stays loaded: Orca cannot unload a shown page; an unloaded one already is.
  discard: defineBrowserExtensionMethod(optionalTabId, (caller, tabId) => {
    const discarded = tabId == null ? null : findBrowserExtensionDiscardedTab(caller.session, tabId)
    return discarded
      ? describeBrowserExtensionDiscardedTab(caller.extension, discarded)
      : describeBrowserExtensionTab(caller.extension, requireTabOrActive(caller, tabId))
  }),
  // Why the page's lang attribute: Chrome runs a text classifier Orca does not have.
  detectLanguage: defineBrowserExtensionMethod(optionalTabId, async (caller, tabId) => {
    const { contents } = requireTabOrActive(caller, tabId)
    const lang: unknown = await contents
      .executeJavaScriptInIsolatedWorld(DETECT_LANGUAGE_WORLD_ID, [{ code: READ_LANG_SCRIPT }])
      .catch(() => '')
    return languageFromLangAttribute(lang)
  })
}
