/// <reference types="chrome" />
import { z } from 'zod'
import { resolveBrowserExtensionRequestedUrl } from '../../../../shared/browser-extension-url'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import {
  activateBrowserExtensionTab,
  closeBrowserExtensionTab,
  createBrowserExtensionTabResolver,
  describeBrowserExtensionTab,
  listBrowserExtensionTabs,
  mergeNativeTab,
  openBrowserExtensionTab,
  requireCallerTab,
  resolveBrowserExtensionTab,
  resolveCallerWindowId,
  type BrowserExtensionTabEntry
} from '../browser-extension-tab-model'
import {
  matchesDiscardedTabNativeQuery,
  matchesOrcaTabQuery,
  type OrcaTabQuery
} from '../browser-extension-tab-query'
import {
  activateBrowserExtensionDiscardedTab,
  closeBrowserExtensionDiscardedTab,
  describeBrowserExtensionDiscardedTab,
  findBrowserExtensionDiscardedTab,
  listBrowserExtensionDiscardedTabs,
  type BrowserExtensionDiscardedTabEntry
} from '../browser-extension-discarded-tab-model'
import { captureVisibleTabMethod } from './tabs-capture'
import { tabsPageMethods } from './tabs-page-methods'
import {
  getLastFocusedBrowserExtensionWindowId,
  listBrowserExtensionWindows
} from '../browser-extension-window-model'

const tabIdSchema = z.number().int().nonnegative()
const nativeTabSchema = z.record(z.string(), z.unknown())
const queryInfoSchema = z
  .object({
    active: z.boolean(),
    highlighted: z.boolean(),
    currentWindow: z.boolean(),
    lastFocusedWindow: z.boolean(),
    windowId: z.number().int(),
    windowType: z.string(),
    status: z.string(),
    index: z.number().int(),
    pinned: z.boolean(),
    discarded: z.boolean(),
    frozen: z.boolean(),
    groupId: z.number().int()
  })
  .partial()
  .loose()
const createPropertiesSchema = z
  .object({
    url: z.string(),
    active: z.boolean(),
    selected: z.boolean(),
    windowId: z.number().int(),
    index: z.number().int(),
    pinned: z.boolean(),
    openerTabId: tabIdSchema
  })
  .partial()
  .loose()
const updatePropertiesSchema = z
  .object({ url: z.string(), muted: z.boolean(), active: z.boolean(), highlighted: z.boolean() })
  .partial()
  .loose()

/** Resolves an extension-requested URL through Orca's rules; extension pages must be loaded in `sess`. */
export function requireOpenableUrl(
  caller: BrowserExtensionCaller,
  rawUrl: string | undefined,
  sess: Electron.Session
): string {
  const resolved = resolveBrowserExtensionRequestedUrl(rawUrl, caller.extension.id)
  if (
    !resolved ||
    (resolved.kind === 'extension' && !sess.extensions.getExtension(resolved.extensionId))
  ) {
    throw new BrowserExtensionApiError(`Cannot open URL: ${rawUrl ?? ''}`)
  }
  return resolved.url
}

async function createTab(
  caller: BrowserExtensionCaller,
  url: string,
  active: boolean
): Promise<chrome.tabs.Tab> {
  const tabId = await openBrowserExtensionTab(caller.browserProfileId, url, active)
  return describeBrowserExtensionTab(caller.extension, requireCallerTab(caller, tabId))
}

/** Electron's own result hides url/title without "tabs"; an activeTab grant still shows them. */
function mergeCallerTab(
  caller: BrowserExtensionCaller,
  nativeTab: Record<string, unknown>,
  entry: BrowserExtensionTabEntry
): chrome.tabs.Tab {
  const tab = mergeNativeTab(nativeTab, entry)
  if (tab.url !== undefined) {
    return tab
  }
  const described = describeBrowserExtensionTab(caller.extension, entry)
  return described.url === undefined ? tab : { ...tab, url: described.url, title: described.title }
}

function queryTabs(
  caller: BrowserExtensionCaller,
  query: OrcaTabQuery,
  nativeTabs: Record<string, unknown>[]
): chrome.tabs.Tab[] {
  const context = {
    callerWindowId: resolveCallerWindowId(caller),
    lastFocusedWindowId: getLastFocusedBrowserExtensionWindowId(caller.session),
    windowTypeById: new Map(
      listBrowserExtensionWindows(caller.session).map((entry) => [entry.window.id, entry.type])
    )
  }
  // Electron's query never sees discarded tabs, so its url/title/audio keys are applied here.
  const discarded = listBrowserExtensionDiscardedTabs(caller.session)
    .map((entry) => describeBrowserExtensionDiscardedTab(caller.extension, entry))
    .filter((tab) => matchesDiscardedTabNativeQuery(tab, query))
  const resolveTab = createBrowserExtensionTabResolver()
  return nativeTabs
    .flatMap((nativeTab) => {
      const entry = typeof nativeTab.id === 'number' ? resolveTab(nativeTab.id) : null
      return entry && entry.contents.session === caller.session
        ? [mergeCallerTab(caller, nativeTab, entry)]
        : []
    })
    .concat(discarded)
    .filter((tab) => matchesOrcaTabQuery(tab, query, context))
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
}

/** Activation shows the page, which loads it (onReplaced follows); a URL needs a loaded page. */
async function updateDiscardedTab(
  caller: BrowserExtensionCaller,
  entry: BrowserExtensionDiscardedTabEntry,
  properties: z.infer<typeof updatePropertiesSchema>
): Promise<chrome.tabs.Tab> {
  if (properties.url !== undefined) {
    throw new BrowserExtensionApiError(`Cannot navigate tab ${entry.tab.tabId} until it loads`)
  }
  if (properties.active || properties.highlighted) {
    await activateBrowserExtensionDiscardedTab(entry)
  }
  const current = findBrowserExtensionDiscardedTab(caller.session, entry.tab.tabId)
  return describeBrowserExtensionDiscardedTab(caller.extension, current ?? entry)
}

export function registerTabsNamespace(): void {
  registerBrowserExtensionNamespace('tabs', {
    methods: {
      // Why the native result rides along: Electron's query owns url/title permission checks.
      query: defineBrowserExtensionMethod(
        z.tuple([queryInfoSchema.optional(), z.array(nativeTabSchema)]),
        (caller, queryInfo, nativeTabs) => queryTabs(caller, queryInfo ?? {}, nativeTabs)
      ),
      // Why a null native result: Electron's get fails for a discarded tab, which only Orca knows.
      get: defineBrowserExtensionMethod(
        z.tuple([tabIdSchema, nativeTabSchema.nullable()]),
        (caller, tabId, nativeTab) => {
          const discarded = findBrowserExtensionDiscardedTab(caller.session, tabId)
          return discarded
            ? describeBrowserExtensionDiscardedTab(caller.extension, discarded)
            : mergeCallerTab(caller, nativeTab ?? {}, requireCallerTab(caller, tabId))
        }
      ),
      getCurrent: defineBrowserExtensionMethod(z.tuple([]), (caller) => {
        const entry = caller.webContents ? resolveBrowserExtensionTab(caller.webContents.id) : null
        return entry ? describeBrowserExtensionTab(caller.extension, entry) : undefined
      }),
      create: defineBrowserExtensionMethod(
        z.tuple([createPropertiesSchema.optional()]),
        (caller, properties) =>
          createTab(
            caller,
            requireOpenableUrl(caller, properties?.url, caller.session),
            properties?.active !== false
          )
      ),
      duplicate: defineBrowserExtensionMethod(z.tuple([tabIdSchema]), (caller, tabId) => {
        const source = requireCallerTab(caller, tabId)
        return createTab(
          caller,
          requireOpenableUrl(caller, source.contents.getURL(), caller.session),
          true
        )
      }),
      remove: defineBrowserExtensionMethod(
        z.tuple([z.union([tabIdSchema, z.array(tabIdSchema)])]),
        async (caller, tabIds) => {
          const entries = (Array.isArray(tabIds) ? tabIds : [tabIds]).map(
            (id) =>
              findBrowserExtensionDiscardedTab(caller.session, id) ?? requireCallerTab(caller, id)
          )
          for (const entry of entries) {
            await ('tab' in entry
              ? closeBrowserExtensionDiscardedTab(entry)
              : closeBrowserExtensionTab(entry))
          }
        }
      ),
      // Why main-side: Electron's native update navigates without Orca's URL rules.
      update: defineBrowserExtensionMethod(
        z.union([
          z.tuple([updatePropertiesSchema]),
          z.tuple([tabIdSchema.nullable().optional(), updatePropertiesSchema])
        ]),
        async (caller, ...args) => {
          const [tabId, properties] = args.length === 1 ? [null, args[0]] : args
          // Chrome: the active tab of the caller's current window.
          const windowId = resolveCallerWindowId(caller)
          const isCurrent = (entry: { active: boolean; windowId: number }): boolean =>
            entry.active && entry.windowId === windowId
          const fallbackId =
            listBrowserExtensionTabs(caller.session).find(isCurrent)?.contents.id ??
            listBrowserExtensionDiscardedTabs(caller.session).find(isCurrent)?.tab.tabId
          const id = tabId ?? fallbackId
          if (id === undefined) {
            throw new BrowserExtensionApiError('No active tab')
          }
          const discarded = findBrowserExtensionDiscardedTab(caller.session, id)
          if (discarded) {
            return updateDiscardedTab(caller, discarded, properties)
          }
          const entry = requireCallerTab(caller, id)
          if (properties.url !== undefined) {
            const url = requireOpenableUrl(caller, properties.url, entry.contents.session)
            entry.contents.loadURL(url).catch(() => {})
          }
          if (properties.muted !== undefined) {
            entry.contents.setAudioMuted(properties.muted)
          }
          // Chrome: highlighting a tab in a one-tab selection model is activating it.
          if (properties.active || properties.highlighted) {
            await activateBrowserExtensionTab(entry)
          }
          return describeBrowserExtensionTab(caller.extension, requireCallerTab(caller, id))
        }
      ),
      captureVisibleTab: captureVisibleTabMethod,
      ...tabsPageMethods
    },
    events: ['onActivated', 'onCreated', 'onUpdated', 'onRemoved', 'onReplaced']
  })
}
