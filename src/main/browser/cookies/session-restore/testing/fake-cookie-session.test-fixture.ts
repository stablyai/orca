import type { Cookie, CookiesSetDetails } from 'electron'
import type { CdpCookie } from '../../browser-cdp-cookie'

type Listener = (event: unknown, cookie: Cookie, cause: string, removed: boolean) => void

/** A cookie jar standing in for an Electron `Session`; `rejected` names fail to set. */
export function fakeSession(rejected: ReadonlySet<string> = new Set()) {
  let jar: Cookie[] = []
  // Set while a test holds the jar's reads, as a slow cookie store would.
  let held: Promise<void> | null = null
  let flushHeld: Promise<void> | null = null
  let onFlush: (() => void) | null = null
  let failingReads = 0
  const listeners = new Set<Listener>()
  // Chromium reports cookie changes on their own channel, after the call that made them.
  const emitLater = (cookie: Cookie, removed: boolean) =>
    setImmediate(() => listeners.forEach((listener) => listener({}, cookie, 'explicit', removed)))
  return {
    names: () => jar.map((cookie) => cookie.name).sort(),
    holdReads: () => {
      let release = () => {}
      held = new Promise((resolve) => (release = resolve))
      return () => {
        held = null
        release()
      }
    },
    /** Settles when the next native flush starts, so a test knows a clear got that far. */
    flushEntered: () => new Promise<void>((resolve) => (onFlush = resolve)),
    holdFlush: () => {
      let release = () => {}
      flushHeld = new Promise((resolve) => (release = resolve))
      return () => {
        flushHeld = null
        release()
      }
    },
    failNextRead: () => {
      failingReads += 1
    },
    cookies: {
      // Like Electron's, `{ session: true }` leaves out persistent cookies.
      get: async (filter: { session?: boolean } = {}) => {
        await held
        if (failingReads > 0) {
          failingReads -= 1
          throw new Error('cookie store unavailable')
        }
        return jar
          .filter((cookie) => filter.session === undefined || cookie.session === filter.session)
          .map((cookie) => ({ ...cookie }))
      },
      set: async (details: CookiesSetDetails) => {
        if (rejected.has(details.name ?? '')) {
          throw new Error('Failed to set cookie')
        }
        const cookie: Cookie = {
          name: details.name ?? '',
          value: details.value ?? '',
          domain: details.domain ?? new URL(details.url).hostname,
          hostOnly: !details.domain,
          path: details.path ?? '/',
          secure: details.secure ?? false,
          httpOnly: details.httpOnly ?? false,
          session: details.expirationDate === undefined,
          expirationDate: details.expirationDate,
          sameSite: details.sameSite ?? 'unspecified'
        }
        // As Chromium does: a set replaces the cookie with the same name, domain and path.
        jar = jar.filter(
          (old) =>
            old.name !== cookie.name || old.domain !== cookie.domain || old.path !== cookie.path
        )
        jar.push(cookie)
        emitLater(cookie, false)
      },
      remove: async (url: string, name: string) => {
        const host = new URL(url).hostname
        const removed = jar.filter(
          (cookie) => cookie.name === name && cookie.domain?.replace(/^\./, '') === host
        )
        jar = jar.filter((cookie) => !removed.includes(cookie))
        removed.forEach((cookie) => emitLater(cookie, true))
      },
      flushStore: async () => {
        onFlush?.()
        onFlush = null
        await flushHeld
      },
      on: (_event: string, listener: Listener) => listeners.add(listener),
      off: (_event: string, listener: Listener) => listeners.delete(listener)
    },
    clearStorageData: async () => {
      const removed = jar
      jar = []
      removed.forEach((cookie) => emitLater(cookie, true))
    }
  }
}

export function sessionCookie(name: string, domain: string): CdpCookie {
  return {
    name,
    value: `${name}-value`,
    domain,
    path: '/',
    secure: true,
    httpOnly: false,
    session: true
  }
}
