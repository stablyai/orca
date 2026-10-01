import type { Session } from 'electron'
import { handleExtensionApi, type ExtensionCaller } from './extension-api-host'
import { objectArg, optionalString, stringArg } from './extension-api-args'
import { extensionCanSeeUrl } from './extension-match-pattern'
import { emitPerExtension, extensionTabs } from './extension-tab-registry'

// Orca's browser sessions have no incognito twin, so each has one store.
const STORE_ID = '0'
const watchedSessions = new WeakSet<Session>()

/** A URL a cookie is sent to, for checking it against host permissions. */
function cookieUrl(cookie: Electron.Cookie): string {
  const host = (cookie.domain ?? '').replace(/^\./, '')
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`
}

function describeCookie(cookie: Electron.Cookie): Record<string, unknown> {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? '',
    hostOnly: cookie.hostOnly ?? false,
    path: cookie.path ?? '/',
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite,
    session: cookie.session ?? true,
    expirationDate: cookie.expirationDate,
    storeId: STORE_ID
  }
}

function requireUrl(caller: ExtensionCaller, value: unknown): string {
  const url = stringArg(value, 'url')
  if (!extensionCanSeeUrl(caller.extension, url)) {
    throw new Error(`No host permissions for cookies at url: "${url}".`)
  }
  return url
}

handleExtensionApi('cookies', {
  get: async (caller: ExtensionCaller, details: unknown) => {
    const args = objectArg(details)
    const url = requireUrl(caller, args.url)
    const [cookie] = await caller.session.cookies.get({ url, name: stringArg(args.name, 'name') })
    return cookie ? describeCookie(cookie) : null
  },
  getAll: async (caller: ExtensionCaller, details: unknown) => {
    const args = objectArg(details)
    const filter: Electron.CookiesGetFilter = {
      url: args.url === undefined ? undefined : requireUrl(caller, args.url),
      name: optionalString(args.name),
      domain: optionalString(args.domain),
      path: optionalString(args.path),
      secure: typeof args.secure === 'boolean' ? args.secure : undefined,
      session: typeof args.session === 'boolean' ? args.session : undefined
    }
    const cookies = await caller.session.cookies.get(filter)
    return cookies
      .filter((cookie) => extensionCanSeeUrl(caller.extension, cookieUrl(cookie)))
      .map(describeCookie)
  },
  set: async (caller: ExtensionCaller, details: unknown) => {
    const args = objectArg(details)
    const url = requireUrl(caller, args.url)
    const sameSite = args.sameSite
    await caller.session.cookies.set({
      url,
      name: optionalString(args.name),
      value: optionalString(args.value),
      domain: optionalString(args.domain),
      path: optionalString(args.path),
      secure: typeof args.secure === 'boolean' ? args.secure : undefined,
      httpOnly: typeof args.httpOnly === 'boolean' ? args.httpOnly : undefined,
      expirationDate: typeof args.expirationDate === 'number' ? args.expirationDate : undefined,
      sameSite:
        sameSite === 'no_restriction' || sameSite === 'lax' || sameSite === 'strict'
          ? sameSite
          : undefined
    })
    const [cookie] = await caller.session.cookies.get({
      url,
      name: optionalString(args.name) ?? ''
    })
    return cookie ? describeCookie(cookie) : null
  },
  remove: async (caller: ExtensionCaller, details: unknown) => {
    const args = objectArg(details)
    const url = requireUrl(caller, args.url)
    const name = stringArg(args.name, 'name')
    await caller.session.cookies.remove(url, name)
    return { url, name, storeId: STORE_ID }
  },
  getAllCookieStores: (caller: ExtensionCaller) => [
    { id: STORE_ID, tabIds: extensionTabs(caller.session).map((tab) => tab.id) }
  ]
})

/** Fires cookies.onChanged for the session, to extensions allowed to see each cookie. */
export function watchExtensionCookies(session: Session): void {
  if (watchedSessions.has(session)) {
    return
  }
  watchedSessions.add(session)
  session.cookies.on('changed', (_event, cookie, cause, removed) => {
    const url = cookieUrl(cookie)
    emitPerExtension(session, 'cookies.onChanged', (extension) =>
      extensionCanSeeUrl(extension, url)
        ? [{ removed, cookie: describeCookie(cookie), cause }]
        : null
    )
  })
}
