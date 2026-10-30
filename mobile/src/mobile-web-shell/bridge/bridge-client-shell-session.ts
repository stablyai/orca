import { TERMINAL_SHORTCUT_STORAGE_KEYS } from '../page-storage-keys'
import { readShellSession, type BridgeShellSession } from './bridge-client-session'
import { bridgeRouteMoved } from './bridge-route-update'
import {
  sameSafeAreaInsets,
  ZERO_SAFE_AREA_INSETS,
  type BridgeSafeAreaInsets
} from './bridge-safe-area-insets'
import {
  EMPTY_PAGE_GEOMETRY,
  samePageGeometry,
  type BridgePageGeometry
} from './bridge-page-geometry'
import { sameFoldDivision, type BridgeFoldDivision } from './bridge-fold-division'
import { sameTerminalKeyRail, type BridgeTerminalKeyRail } from './bridge-terminal-key'
import type {
  BridgeColorScheme,
  BridgeConnectionSnapshot,
  BridgeHostMessage,
  BridgeInitRoute,
  BridgeUiLocale
} from './bridge-envelope'

type InitMessage = Extract<BridgeHostMessage, { type: 'init' }>

// Same-session init preserves exchanges; replacement drops prior work before publishing the new session to listeners.
export type BridgeClientShellSession = {
  current: () => BridgeShellSession | null
  accept: (message: InitMessage) => void
  onReady: (listener: () => void) => () => void
  /**
   * Fires each time the shell rewrites a param of the screen this page is already on, which is a
   * second `init` for the session it already holds. Never for the first one, and never for a
   * re-sent `init` whose route is the one the page already holds — a re-asked `ready` is answered
   * with that route and is not a request.
   *
   * One delivery per tap rather than one per distinct value: the shell clears the param after each
   * delivery, so a notification tap for the pane already showing arrives as a real move and a
   * listener that deduplicated by value would lose exactly that one.
   */
  onStorageUpdate: (listener: () => void) => () => void
  onRouteUpdate: (listener: (route: BridgeInitRoute | null) => void) => () => void
  onSafeAreaInsetsUpdate: (listener: (insets: BridgeSafeAreaInsets) => void) => () => void
  onKeyboardInsetUpdate: (listener: (height: number) => void) => () => void
  /** Fires when an `init` moved the fold the page holds, including a replacement's. */
  onPageGeometryUpdate: (listener: (geometry: BridgePageGeometry) => void) => () => void
  onFoldDivisionUpdate: (listener: (division: BridgeFoldDivision | null) => void) => () => void
  /** Fires when an `init` moved the keys the shell's rail shows, including a replacement's. */
  onTerminalKeyRailUpdate: (listener: (keys: BridgeTerminalKeyRail) => void) => () => void
  onColorSchemeUpdate: (listener: (scheme: BridgeColorScheme) => void) => () => void
  onUiLocaleUpdate: (listener: (locale: BridgeUiLocale | null) => void) => () => void
  /** Drops the session and every listener waiting on one, which `close` is the only caller of. */
  close: () => void
}

/** The session's listeners, which the page client hands on as its own members. */
export type BridgeShellSessionListeners = Pick<
  BridgeClientShellSession,
  | 'onReady'
  | 'onRouteUpdate'
  | 'onStorageUpdate'
  | 'onSafeAreaInsetsUpdate'
  | 'onKeyboardInsetUpdate'
  | 'onColorSchemeUpdate'
  | 'onUiLocaleUpdate'
  | 'onPageGeometryUpdate'
  | 'onFoldDivisionUpdate'
  | 'onTerminalKeyRailUpdate'
>

/** Picked rather than spread: the session's `accept` and `close` are the client's alone. */
export function shellSessionListeners(
  session: BridgeClientShellSession
): BridgeShellSessionListeners {
  return {
    onReady: session.onReady,
    onRouteUpdate: session.onRouteUpdate,
    onStorageUpdate: session.onStorageUpdate,
    onSafeAreaInsetsUpdate: session.onSafeAreaInsetsUpdate,
    onKeyboardInsetUpdate: session.onKeyboardInsetUpdate,
    onColorSchemeUpdate: session.onColorSchemeUpdate,
    onUiLocaleUpdate: session.onUiLocaleUpdate,
    onPageGeometryUpdate: session.onPageGeometryUpdate,
    onFoldDivisionUpdate: session.onFoldDivisionUpdate,
    onTerminalKeyRailUpdate: session.onTerminalKeyRailUpdate
  }
}

export function createBridgeClientShellSession(args: {
  onReplaced: () => void
  prime: (connection: BridgeConnectionSnapshot) => void
}): BridgeClientShellSession {
  let session: BridgeShellSession | null = null
  const storageListeners = new Set<() => void>()
  const readyListeners = new Set<() => void>()
  const routeUpdateListeners = new Set<(route: BridgeInitRoute | null) => void>()
  const insetsListeners = new Set<(insets: BridgeSafeAreaInsets) => void>()
  const keyboardListeners = new Set<(height: number) => void>()
  const geometryListeners = new Set<(geometry: BridgePageGeometry) => void>()
  const foldListeners = new Set<(division: BridgeFoldDivision | null) => void>()
  const railListeners = new Set<(keys: BridgeTerminalKeyRail) => void>()
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
      const refreshShortcuts = update !== null && message.refreshTerminalShortcuts === true
      const sentStorage = message.storage ?? {}
      const sentOversize = message.storageOversize ?? []
      const storage = refreshShortcuts ? { ...update.storage } : undefined
      const storageOversize = refreshShortcuts
        ? [
            ...update.storageOversize.filter(
              (key) => !TERMINAL_SHORTCUT_STORAGE_KEYS.some((item) => item === key)
            ),
            ...TERMINAL_SHORTCUT_STORAGE_KEYS.filter((key) => sentOversize.includes(key))
          ]
        : update?.storageOversize
      if (refreshShortcuts && storage) {
        for (const key of TERMINAL_SHORTCUT_STORAGE_KEYS) {
          if (sentStorage[key] === undefined) {
            delete storage[key]
          } else {
            storage[key] = sentStorage[key]
          }
        }
      }
      const sent = message.safeAreaInsets ?? ZERO_SAFE_AREA_INSETS
      const movedInsets = held !== null && !sameSafeAreaInsets(held.safeAreaInsets, sent)
      // Reuse equal values’ identity so repeated ready cannot rerender keyed readers.
      const safeAreaInsets = held === null || movedInsets ? sent : held.safeAreaInsets
      const keyboardInset = message.keyboardInset ?? 0
      const movedKeyboard = held !== null && held.keyboardInset !== keyboardInset
      const sentGeometry = message.pageGeometry ?? EMPTY_PAGE_GEOMETRY
      const movedGeometry = held !== null && !samePageGeometry(held.pageGeometry, sentGeometry)
      const pageGeometry = held === null || movedGeometry ? sentGeometry : held.pageGeometry
      const sentFold = message.foldDivision ?? null
      const movedFold = held !== null && !sameFoldDivision(held.foldDivision, sentFold)
      const foldDivision = held === null || movedFold ? sentFold : held.foldDivision
      const sentRail = message.terminalKeyRail ?? []
      const movedRail = held !== null && !sameTerminalKeyRail(held.terminalKeyRail, sentRail)
      const terminalKeyRail = held === null || movedRail ? sentRail : held.terminalKeyRail
      const colorScheme = message.colorScheme ?? 'dark'
      const movedScheme = held !== null && held.colorScheme !== colorScheme
      const uiLocale = message.uiLocale ?? null
      const movedUiLocale = held !== null && held.uiLocale !== uiLocale
      session =
        update === null
          ? {
              ...readShellSession(message),
              safeAreaInsets,
              pageGeometry,
              foldDivision,
              terminalKeyRail
            }
          : {
              ...update,
              storage: storage ?? update.storage,
              storageOversize: storageOversize ?? update.storageOversize,
              route: message.route ?? null,
              safeAreaInsets,
              keyboardInset,
              pageGeometry,
              foldDivision,
              terminalKeyRail,
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
      if (refreshShortcuts) {
        for (const listener of storageListeners) {
          listener()
        }
      }
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
      if (movedGeometry) {
        for (const listener of geometryListeners) {
          listener(pageGeometry)
        }
      }
      if (movedFold) {
        for (const listener of foldListeners) {
          listener(foldDivision)
        }
      }
      if (movedRail) {
        for (const listener of railListeners) {
          listener(terminalKeyRail)
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
    // Not fired on subscribe, and no replay: a listener that arrives late reads the route it wants
    // off `current`, and what this publishes is the fact that one moved.
    onStorageUpdate: (listener) => {
      storageListeners.add(listener)
      return () => {
        storageListeners.delete(listener)
      }
    },
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
    onPageGeometryUpdate: (listener) => {
      geometryListeners.add(listener)
      return () => {
        geometryListeners.delete(listener)
      }
    },
    onFoldDivisionUpdate: (listener) => {
      foldListeners.add(listener)
      return () => {
        foldListeners.delete(listener)
      }
    },
    onTerminalKeyRailUpdate: (listener) => {
      railListeners.add(listener)
      return () => {
        railListeners.delete(listener)
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
