import { readShellSession, type BridgeShellSession } from './bridge-client-session'
import { bridgeRouteMoved } from './bridge-route-update'
import {
  sameSafeAreaInsets,
  ZERO_SAFE_AREA_INSETS,
  type BridgeSafeAreaInsets
} from './bridge-safe-area-insets'
import type {
  BridgeColorScheme,
  BridgeConnectionSnapshot,
  BridgeHostMessage,
  BridgeInitRoute,
  BridgeUiLocale
} from './bridge-envelope'

type InitMessage = Extract<BridgeHostMessage, { type: 'init' }>

function sameStorageEntries(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  )
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/**
 * The session the page holds, and who it tells when `init` changes it.
 *
 * Its own module because it is the one piece of the client with a lifecycle rather than a value:
 * a second `init` for the same session updates it in place, a different one replaces it and takes
 * the requests and streams of the session before it, and each case has its own listeners to fire
 * in its own order. The client keeps the frames and the ports; this keeps what they are for.
 */
export type BridgeStorageUpdateListener = (
  storage: Readonly<Record<string, string>>,
  storageOversize: readonly string[]
) => void

export type BridgeClientShellSession = {
  current: () => BridgeShellSession | null
  accept: (message: InitMessage) => void
  onReady: (listener: () => void) => () => void
  onRouteUpdate: (listener: (route: BridgeInitRoute | null) => void) => () => void
  onSafeAreaInsetsUpdate: (listener: (insets: BridgeSafeAreaInsets) => void) => () => void
  onKeyboardInsetUpdate: (listener: (height: number) => void) => () => void
  /** Fires when an `init` moved the storage snapshot the page holds, including a replacement's. */
  onStorageUpdate: (listener: BridgeStorageUpdateListener) => () => void
  onColorSchemeUpdate: (listener: (scheme: BridgeColorScheme) => void) => () => void
  onUiLocaleUpdate: (listener: (locale: BridgeUiLocale | null) => void) => () => void
  /** Drops the session and every listener waiting on one, which `close` is the only caller of. */
  close: () => void
}

export function createBridgeClientShellSession(args: {
  onReplaced: () => void
  prime: (connection: BridgeConnectionSnapshot) => void
}): BridgeClientShellSession {
  let session: BridgeShellSession | null = null
  const readyListeners = new Set<() => void>()
  const routeUpdateListeners = new Set<(route: BridgeInitRoute | null) => void>()
  const insetsListeners = new Set<(insets: BridgeSafeAreaInsets) => void>()
  const keyboardListeners = new Set<(height: number) => void>()
  const storageListeners = new Set<
    (storage: Readonly<Record<string, string>>, storageOversize: readonly string[]) => void
  >()
  const schemeListeners = new Set<(scheme: BridgeColorScheme) => void>()
  const uiLocaleListeners = new Set<(locale: BridgeUiLocale | null) => void>()

  return {
    current: () => session,
    accept: (message) => {
      const held = session
      const update = held !== null && held.sessionId === message.sessionId ? held : null
      if (held !== null && update === null) {
        args.onReplaced()
      }
      // Preserve the original storage snapshot across same-session init while rebuilding the session value with new route/insets.
      const sent = message.safeAreaInsets ?? ZERO_SAFE_AREA_INSETS
      const movedInsets = held !== null && !sameSafeAreaInsets(held.safeAreaInsets, sent)
      // Reuse equal values’ identity so repeated ready cannot rerender keyed readers.
      const safeAreaInsets = held === null || movedInsets ? sent : held.safeAreaInsets
      const keyboardInset = message.keyboardInset ?? 0
      const movedKeyboard = held !== null && held.keyboardInset !== keyboardInset
      const nextSession = readShellSession(message)
      const movedStorage =
        held !== null &&
        (!sameStorageEntries(held.storage, nextSession.storage) ||
          !sameStringList(held.storageOversize, nextSession.storageOversize))
      const storage = held === null || movedStorage ? nextSession.storage : held.storage
      const storageOversize =
        held === null || movedStorage ? nextSession.storageOversize : held.storageOversize
      const colorScheme = message.colorScheme ?? 'dark'
      const movedScheme = held !== null && held.colorScheme !== colorScheme
      const uiLocale = message.uiLocale ?? null
      const movedUiLocale = held !== null && held.uiLocale !== uiLocale
      session =
        update === null
          ? { ...nextSession, safeAreaInsets, storage, storageOversize, colorScheme }
          : {
              ...update,
              route: message.route ?? null,
              safeAreaInsets,
              keyboardInset,
              storage,
              storageOversize,
              colorScheme,
              uiLocale
            }
      // Re-primed either way, because a second `init` is also how the page recovers a cache it has
      // refused a `state` frame into: the shell rebuilt under it publishes a generation the page's
      // own is newer than, and this frame is what puts the two back in step. A pane update carries
      // the same snapshot it already holds, which `prime` answers with no transition.
      args.prime(message.connection)
      for (const listener of readyListeners) {
        listener()
      }
      readyListeners.clear()
      if (movedInsets) {
        for (const listener of insetsListeners) {
          listener(safeAreaInsets)
        }
      }
      if (movedKeyboard) {
        for (const listener of keyboardListeners) {
          listener(keyboardInset)
        }
      }
      if (movedStorage) {
        for (const listener of storageListeners) {
          listener(storage, storageOversize)
        }
      }
      if (movedScheme) {
        for (const listener of schemeListeners) {
          listener(colorScheme)
        }
      }
      if (movedUiLocale) {
        for (const listener of uiLocaleListeners) {
          listener(uiLocale)
        }
      }
      // Only a route that moved is an update. The shell answers every `ready` with the route it
      // holds, and the page re-asks after a refused `state` frame, so publishing each of those
      // would hand the pane hook the route it is already on.
      if (update === null || !bridgeRouteMoved(update.route, session.route)) {
        return
      }
      for (const listener of routeUpdateListeners) {
        listener(session.route)
      }
    },
    onReady: (listener) => {
      if (session !== null) {
        listener()
        return () => undefined
      }
      readyListeners.add(listener)
      return () => {
        readyListeners.delete(listener)
      }
    },
    // Late listeners read current; updates report changes without replaying the held route.
    onRouteUpdate: (listener) => {
      routeUpdateListeners.add(listener)
      return () => {
        routeUpdateListeners.delete(listener)
      }
    },
    onSafeAreaInsetsUpdate: (listener) => {
      insetsListeners.add(listener)
      return () => {
        insetsListeners.delete(listener)
      }
    },
    onKeyboardInsetUpdate: (listener) => {
      keyboardListeners.add(listener)
      return () => {
        keyboardListeners.delete(listener)
      }
    },
    onStorageUpdate: (listener) => {
      storageListeners.add(listener)
      return () => {
        storageListeners.delete(listener)
      }
    },
    onColorSchemeUpdate: (listener) => {
      schemeListeners.add(listener)
      return () => {
        schemeListeners.delete(listener)
      }
    },
    onUiLocaleUpdate: (listener) => {
      uiLocaleListeners.add(listener)
      return () => {
        uiLocaleListeners.delete(listener)
      }
    },
    close: () => {
      session = null
      readyListeners.clear()
    }
  }
}
