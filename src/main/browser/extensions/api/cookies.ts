/// <reference types="chrome" />
import { z } from 'zod'
import { emitBrowserExtensionEvent } from '../browser-extension-api-host'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import { hasBrowserExtensionHostPermission } from '../browser-extension-permission-grants'
import { listBrowserExtensionTabs } from '../browser-extension-tab-model'
import { browserExtensionHostPatternsInSession } from './permissions'

/** Each extension session has one cookie store; Chrome names the regular store "0". */
const STORE_ID = '0'

const storeIdSchema = z.string().optional()
const getSchema = z.object({ url: z.string(), name: z.string(), storeId: storeIdSchema }).loose()
const getAllSchema = z
  .object({
    url: z.string(),
    name: z.string(),
    domain: z.string(),
    path: z.string(),
    secure: z.boolean(),
    session: z.boolean(),
    storeId: z.string()
  })
  .partial()
  .loose()
const setSchema = z
  .object({
    url: z.string(),
    name: z.string().optional(),
    value: z.string().optional(),
    domain: z.string().optional(),
    path: z.string().optional(),
    secure: z.boolean().optional(),
    httpOnly: z.boolean().optional(),
    sameSite: z.enum(['no_restriction', 'lax', 'strict', 'unspecified']).optional(),
    expirationDate: z.number().optional(),
    storeId: storeIdSchema
  })
  .loose()

/** A URL that a cookie is sent to, for host-permission checks. */
export function cookieUrl(cookie: Pick<Electron.Cookie, 'domain' | 'path' | 'secure'>): string {
  const host = (cookie.domain ?? '').replace(/^\./, '')
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`
}

export function toChromeCookie(cookie: Electron.Cookie): chrome.cookies.Cookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? '',
    hostOnly: cookie.hostOnly ?? false,
    path: cookie.path ?? '/',
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite,
    session: cookie.session ?? false,
    ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}),
    storeId: STORE_ID
  }
}

const CAUSES: Record<string, string> = {
  explicit: 'explicit',
  overwrite: 'overwrite',
  expired: 'expired',
  evicted: 'evicted',
  'expired-overwrite': 'expired_overwrite'
}

function checkStore(storeId: string | undefined): void {
  if (storeId !== undefined && storeId !== STORE_ID) {
    throw new BrowserExtensionApiError(`Invalid cookie store id: "${storeId}".`)
  }
}

function hostPatterns(caller: BrowserExtensionCaller): string[] {
  return browserExtensionHostPatternsInSession(caller.extension, caller.session)
}

function requireHostPermission(caller: BrowserExtensionCaller, url: string): void {
  if (!hasBrowserExtensionHostPermission(hostPatterns(caller), url)) {
    throw new BrowserExtensionApiError(`No host permissions for cookies at url: "${url}".`)
  }
}

async function findCookie(
  caller: BrowserExtensionCaller,
  url: string,
  name: string
): Promise<chrome.cookies.Cookie | null> {
  const cookies = await caller.session.cookies.get({ url, name })
  // Why longest path first: Chrome returns the most specific match.
  const best = cookies.sort((a, b) => (b.path ?? '').length - (a.path ?? '').length)[0]
  return best ? toChromeCookie(best) : null
}

const observedSessions = new WeakSet<Electron.Session>()

/** cookies.onChanged, delivered only to extensions with host permission for that cookie. */
export function observeBrowserExtensionCookieChanges(session: Electron.Session): void {
  if (observedSessions.has(session)) {
    return
  }
  observedSessions.add(session)
  session.cookies.on('changed', (_event, cookie, cause, removed) => {
    const url = cookieUrl(cookie)
    emitBrowserExtensionEvent({ session }, 'cookies', 'onChanged', (extension) =>
      hasBrowserExtensionHostPermission(
        browserExtensionHostPatternsInSession(extension, session),
        url
      )
        ? [{ removed, cookie: toChromeCookie(cookie), cause: CAUSES[cause] ?? 'explicit' }]
        : null
    )
  })
}

export function registerCookiesNamespace(): void {
  registerBrowserExtensionNamespace('cookies', {
    permission: 'cookies',
    methods: {
      get: defineBrowserExtensionMethod(z.tuple([getSchema]), async (caller, details) => {
        checkStore(details.storeId)
        requireHostPermission(caller, details.url)
        return findCookie(caller, details.url, details.name)
      }),
      getAll: defineBrowserExtensionMethod(z.tuple([getAllSchema]), async (caller, details) => {
        checkStore(details.storeId)
        const { url, name, domain, path, secure, session } = details
        // Why: Electron's argument converter rejects explicit undefined for typed cookie fields.
        const filter: Electron.CookiesGetFilter = Object.fromEntries(
          Object.entries({ url, name, domain, path, secure, session }).filter(
            ([, value]) => value !== undefined
          )
        )
        const cookies = await caller.session.cookies.get(filter)
        const patterns = hostPatterns(caller)
        return cookies
          .filter((cookie) => hasBrowserExtensionHostPermission(patterns, cookieUrl(cookie)))
          .map(toChromeCookie)
      }),
      set: defineBrowserExtensionMethod(z.tuple([setSchema]), async (caller, details) => {
        checkStore(details.storeId)
        requireHostPermission(caller, details.url)
        const { url, name = '', value = '', domain, path, secure, httpOnly } = details
        const { expirationDate, sameSite } = details
        try {
          const optional: Omit<Electron.CookiesSetDetails, 'url'> = Object.fromEntries(
            Object.entries({ domain, path, secure, httpOnly, expirationDate, sameSite }).filter(
              ([, entry]) => entry !== undefined
            )
          )
          await caller.session.cookies.set({ url, name, value, ...optional })
        } catch (error) {
          throw new BrowserExtensionApiError(
            `Failed to parse or set cookie named "${name}". ${error instanceof Error ? error.message : ''}`.trim()
          )
        }
        return findCookie(caller, url, name)
      }),
      remove: defineBrowserExtensionMethod(z.tuple([getSchema]), async (caller, details) => {
        checkStore(details.storeId)
        requireHostPermission(caller, details.url)
        await caller.session.cookies.remove(details.url, details.name)
        return { url: details.url, name: details.name, storeId: STORE_ID }
      }),
      getAllCookieStores: defineBrowserExtensionMethod(z.tuple([]), (caller) => [
        {
          id: STORE_ID,
          tabIds: listBrowserExtensionTabs(caller.session).map((entry) => entry.contents.id)
        }
      ])
    },
    events: ['onChanged']
  })
}
