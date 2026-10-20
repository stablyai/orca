/// <reference types="chrome" />
import { z } from 'zod'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import {
  describeBrowserExtensionTab,
  listBrowserExtensionTabs,
  resolveCallerWindowId
} from '../browser-extension-tab-model'
import {
  WINDOW_ID_CURRENT,
  createBrowserExtensionPopout,
  describeBrowserExtensionWindow,
  getBrowserExtensionWindow,
  getLastFocusedBrowserExtensionWindowId,
  listBrowserExtensionWindows,
  presentBrowserExtensionWindow,
  type BrowserExtensionWindowEntry
} from '../browser-extension-window-model'
import { requireOpenableUrl } from './tabs'

const windowIdSchema = z.number().int()
const queryOptionsSchema = z
  .object({ populate: z.boolean(), windowTypes: z.array(z.string()) })
  .partial()
  .loose()
const windowStateSchema = z.enum(['normal', 'minimized', 'maximized', 'fullscreen'])
const createDataSchema = z
  .object({
    url: z.union([z.string(), z.array(z.string())]),
    tabId: z.number().int(),
    left: z.number().int(),
    top: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    focused: z.boolean(),
    incognito: z.boolean(),
    type: z.enum(['normal', 'popup', 'panel']),
    state: windowStateSchema,
    setSelfAsOpener: z.boolean()
  })
  .partial()
  .loose()
const updateInfoSchema = z
  .object({
    left: z.number().int(),
    top: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    focused: z.boolean(),
    drawAttention: z.boolean(),
    state: windowStateSchema
  })
  .partial()
  .loose()

type QueryOptions = z.infer<typeof queryOptionsSchema>

function describe(
  caller: BrowserExtensionCaller,
  entry: BrowserExtensionWindowEntry,
  options: QueryOptions | undefined
): chrome.windows.Window {
  const tabs = options?.populate
    ? listBrowserExtensionTabs(caller.session)
        .filter((tab) => tab.windowId === entry.window.id)
        .map((tab) => describeBrowserExtensionTab(caller.extension, tab))
    : undefined
  return describeBrowserExtensionWindow(entry, tabs)
}

function requireWindow(
  caller: BrowserExtensionCaller,
  windowId: number
): BrowserExtensionWindowEntry {
  const resolvedId = windowId === WINDOW_ID_CURRENT ? resolveCallerWindowId(caller) : windowId
  const entry = resolvedId === null ? null : getBrowserExtensionWindow(resolvedId)
  if (!entry) {
    throw new BrowserExtensionApiError(`No window with id: ${windowId}.`)
  }
  return entry
}

function applyWindowUpdate(
  entry: BrowserExtensionWindowEntry,
  info: z.infer<typeof updateInfoSchema>
): void {
  const { window } = entry
  // Why: extensions may focus Orca's main window but never move, resize or minimize it.
  if (!entry.isMain) {
    if (info.state === 'minimized') {
      window.minimize()
    } else if (info.state === 'maximized') {
      window.maximize()
    } else if (info.state === 'fullscreen') {
      window.setFullScreen(true)
    } else if (info.state === 'normal') {
      window.setFullScreen(false)
      window.unmaximize()
      window.restore()
    }
    const bounds = window.getBounds()
    window.setBounds({
      x: info.left ?? bounds.x,
      y: info.top ?? bounds.y,
      width: info.width ?? bounds.width,
      height: info.height ?? bounds.height
    })
  }
  if (info.drawAttention !== undefined) {
    window.flashFrame(info.drawAttention)
  }
  if (info.focused) {
    presentBrowserExtensionWindow(window, true)
  }
}

export function registerWindowsNamespace(): void {
  registerBrowserExtensionNamespace('windows', {
    methods: {
      getAll: defineBrowserExtensionMethod(
        z.tuple([queryOptionsSchema.optional()]),
        (caller, options) =>
          listBrowserExtensionWindows()
            .filter((entry) => !options?.windowTypes || options.windowTypes.includes(entry.type))
            .map((entry) => describe(caller, entry, options))
      ),
      get: defineBrowserExtensionMethod(
        z.tuple([windowIdSchema, queryOptionsSchema.optional()]),
        (caller, windowId, options) => describe(caller, requireWindow(caller, windowId), options)
      ),
      getCurrent: defineBrowserExtensionMethod(
        z.tuple([queryOptionsSchema.optional()]),
        (caller, options) => describe(caller, requireWindow(caller, WINDOW_ID_CURRENT), options)
      ),
      getLastFocused: defineBrowserExtensionMethod(
        z.tuple([queryOptionsSchema.optional()]),
        (caller, options) => {
          const windowId = getLastFocusedBrowserExtensionWindowId()
          return describe(caller, requireWindow(caller, windowId ?? WINDOW_ID_CURRENT), options)
        }
      ),
      create: defineBrowserExtensionMethod(
        z.tuple([createDataSchema.optional()]),
        (caller, data) => {
          if (data?.incognito) {
            throw new BrowserExtensionApiError('Incognito windows are not supported')
          }
          if (data?.tabId !== undefined) {
            throw new BrowserExtensionApiError('Moving a tab into a new window is not supported')
          }
          const rawUrl = Array.isArray(data?.url) ? data.url[0] : data?.url
          const window = createBrowserExtensionPopout(caller.session, {
            url: requireOpenableUrl(caller, rawUrl, caller.session),
            type: data?.type === 'normal' ? 'normal' : 'popup',
            left: data?.left,
            top: data?.top,
            width: data?.width,
            height: data?.height,
            focused: data?.focused !== false,
            state: data?.state
          })
          return describe(caller, requireWindow(caller, window.id), { populate: true })
        }
      ),
      update: defineBrowserExtensionMethod(
        z.tuple([windowIdSchema, updateInfoSchema]),
        (caller, windowId, info) => {
          const entry = requireWindow(caller, windowId)
          applyWindowUpdate(entry, info)
          return describe(caller, entry, undefined)
        }
      ),
      remove: defineBrowserExtensionMethod(z.tuple([windowIdSchema]), (caller, windowId) => {
        const entry = requireWindow(caller, windowId)
        if (entry.isMain) {
          throw new BrowserExtensionApiError("Extensions cannot close Orca's main window")
        }
        entry.window.close()
      })
    },
    events: ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged']
  })
}
