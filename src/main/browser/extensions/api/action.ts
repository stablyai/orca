import { z } from 'zod'
import { getChromeExtensionOrigin } from '../../../../shared/browser-extension-url'
import { iconFromImageData } from '../browser-extension-action-icon'
import {
  getBrowserExtensionActionState,
  notifyBrowserExtensionActionsChanged
} from '../browser-extension-action-registry'
import {
  iconFromPathSpec,
  parseBrowserExtensionColor,
  type BrowserExtensionActionDetails,
  type BrowserExtensionColor
} from '../browser-extension-action-state'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller,
  type BrowserExtensionNamespace
} from '../browser-extension-namespace-registry'
import { requireCallerTab } from '../browser-extension-tab-model'
import { getPinnedBrowserExtensionIds } from '../browser-extension-toolbar-pins'
import { requestBrowserExtensionPopup } from '../browser-extension-toolbar'

const tabIdSchema = z.number().int().nonnegative()
const tabDetailsSchema = z.object({ tabId: tabIdSchema.optional() }).loose()
const colorSchema = z.union([z.string(), z.array(z.number())])
const UNSET_COLOR: BrowserExtensionColor = [0, 0, 0, 0]

/** A tabId must name a tab the caller can reach; omitted means the global value. */
function scopeTab(caller: BrowserExtensionCaller, tabId: number | undefined): number | null {
  if (tabId === undefined) {
    return null
  }
  requireCallerTab(caller, tabId)
  return tabId
}

function setDetail<Key extends keyof BrowserExtensionActionDetails>(
  caller: BrowserExtensionCaller,
  key: Key,
  value: BrowserExtensionActionDetails[Key] | null,
  tabId: number | undefined
): void {
  const scope = scopeTab(caller, tabId)
  getBrowserExtensionActionState(caller.browserProfileId, caller.extension).set(key, value, scope)
  notifyBrowserExtensionActionsChanged(caller.browserProfileId)
}

function getDetails(
  caller: BrowserExtensionCaller,
  tabId: number | undefined
): BrowserExtensionActionDetails {
  return getBrowserExtensionActionState(caller.browserProfileId, caller.extension).get(
    scopeTab(caller, tabId)
  )
}

function requireColor(input: unknown): BrowserExtensionColor {
  const color = parseBrowserExtensionColor(input)
  if (!color) {
    throw new BrowserExtensionApiError('The color specification could not be parsed.')
  }
  return color
}

/** setPopup takes a path relative to the extension root (or this extension's own URL). */
function normalizePopupPath(caller: BrowserExtensionCaller, popup: string): string {
  if (popup === '') {
    return ''
  }
  const origin = `${getChromeExtensionOrigin(caller.extension.id)}/`
  const url = new URL(popup, origin)
  if (!url.href.startsWith(origin)) {
    throw new BrowserExtensionApiError('The popup must be a page of this extension')
  }
  return url.pathname.slice(1) + url.search + url.hash
}

/** The calling page, or the worker script (Orca's wrapper sits beside the original). */
function callerBaseUrl(caller: BrowserExtensionCaller, origin: string): string {
  const background: { service_worker?: unknown } = caller.extension.manifest?.background ?? {}
  const worker = background.service_worker
  if (caller.frame && !caller.frame.isDestroyed()) {
    return caller.frame.url
  }
  return typeof worker === 'string' ? new URL(worker, origin).href : origin
}

// Why: Chrome resolves icon paths against the calling script (Vimium passes ../icons/...) and
// accepts the extension's own URLs (Tampermonkey); Orca reads them root-relative from the package.
function normalizeIconPaths(
  caller: BrowserExtensionCaller,
  path: string | Record<string, string> | undefined
): string | Record<string, string> | undefined {
  const origin = `${getChromeExtensionOrigin(caller.extension.id)}/`
  const base = callerBaseUrl(caller, origin)
  const toPath = (value: string): string => {
    try {
      const url = new URL(value, base)
      return url.href.startsWith(origin) ? decodeURIComponent(url.pathname.slice(1)) : value
    } catch {
      return value
    }
  }
  if (typeof path === 'string') {
    return toPath(path)
  }
  return (
    path && Object.fromEntries(Object.entries(path).map(([size, value]) => [size, toPath(value)]))
  )
}

function isOnToolbar(caller: BrowserExtensionCaller): boolean {
  return getPinnedBrowserExtensionIds(caller.browserProfileId).includes(caller.extension.id)
}

function createActionNamespace(): BrowserExtensionNamespace {
  const optionalTabId = z.tuple([tabIdSchema.optional()])
  return {
    methods: {
      setTitle: defineBrowserExtensionMethod(
        z.tuple([tabDetailsSchema.extend({ title: z.string() })]),
        (caller, { title, tabId }) => setDetail(caller, 'title', title, tabId)
      ),
      getTitle: defineBrowserExtensionMethod(
        z.tuple([tabDetailsSchema.optional()]),
        (caller, details) => getDetails(caller, details?.tabId).title
      ),
      setIcon: defineBrowserExtensionMethod(
        z.tuple([
          tabDetailsSchema.extend({
            imageData: z.unknown().optional(),
            path: z.union([z.string(), z.record(z.string(), z.string())]).optional()
          })
        ]),
        (caller, { imageData, path, tabId }) => {
          const icon =
            imageData !== undefined
              ? iconFromImageData(imageData)
              : iconFromPathSpec(normalizeIconPaths(caller, path))
          if (!icon) {
            throw new BrowserExtensionApiError('Either path or imageData must be specified.')
          }
          setDetail(caller, 'icon', icon, tabId)
        }
      ),
      setPopup: defineBrowserExtensionMethod(
        z.tuple([tabDetailsSchema.extend({ popup: z.string() })]),
        (caller, { popup, tabId }) =>
          setDetail(caller, 'popup', normalizePopupPath(caller, popup), tabId)
      ),
      getPopup: defineBrowserExtensionMethod(
        z.tuple([tabDetailsSchema.optional()]),
        (caller, details) => {
          const popup = getDetails(caller, details?.tabId).popup
          return popup === '' ? '' : `${getChromeExtensionOrigin(caller.extension.id)}/${popup}`
        }
      ),
      setBadgeText: defineBrowserExtensionMethod(
        z.tuple([tabDetailsSchema.extend({ text: z.string().nullable().optional() })]),
        (caller, { text, tabId }) =>
          // Why: Chrome clears a tab's text with null/undefined but keeps '' as an explicit value.
          setDetail(caller, 'badgeText', text ?? (tabId === undefined ? '' : null), tabId)
      ),
      getBadgeText: defineBrowserExtensionMethod(
        z.tuple([tabDetailsSchema.optional()]),
        (caller, details) => getDetails(caller, details?.tabId).badgeText
      ),
      setBadgeBackgroundColor: defineBrowserExtensionMethod(
        z.tuple([tabDetailsSchema.extend({ color: colorSchema })]),
        (caller, { color, tabId }) =>
          setDetail(caller, 'badgeBackgroundColor', requireColor(color), tabId)
      ),
      getBadgeBackgroundColor: defineBrowserExtensionMethod(
        z.tuple([tabDetailsSchema.optional()]),
        (caller, details) => getDetails(caller, details?.tabId).badgeBackgroundColor ?? UNSET_COLOR
      ),
      setBadgeTextColor: defineBrowserExtensionMethod(
        z.tuple([tabDetailsSchema.extend({ color: colorSchema })]),
        (caller, { color, tabId }) =>
          setDetail(caller, 'badgeTextColor', requireColor(color), tabId)
      ),
      getBadgeTextColor: defineBrowserExtensionMethod(
        z.tuple([tabDetailsSchema.optional()]),
        (caller, details) => getDetails(caller, details?.tabId).badgeTextColor ?? UNSET_COLOR
      ),
      enable: defineBrowserExtensionMethod(optionalTabId, (caller, tabId) =>
        setDetail(caller, 'enabled', true, tabId)
      ),
      disable: defineBrowserExtensionMethod(optionalTabId, (caller, tabId) =>
        setDetail(caller, 'enabled', false, tabId)
      ),
      isEnabled: defineBrowserExtensionMethod(
        optionalTabId,
        (caller, tabId) => getDetails(caller, tabId).enabled
      ),
      getUserSettings: defineBrowserExtensionMethod(z.tuple([]), (caller) => ({
        isOnToolbar: isOnToolbar(caller)
      })),
      openPopup: defineBrowserExtensionMethod(
        z.tuple([z.object({ windowId: z.number().int() }).loose().optional()]),
        (caller) => requestBrowserExtensionPopup(caller.session, caller.extension.id)
      )
    },
    events: ['onClicked', 'onUserSettingsChanged']
  }
}

/** chrome.action (MV3) and its MV2 name chrome.browserAction share one implementation. */
export function registerActionNamespace(): void {
  const namespace = createActionNamespace()
  registerBrowserExtensionNamespace('action', namespace)
  registerBrowserExtensionNamespace('browserAction', namespace)
}
