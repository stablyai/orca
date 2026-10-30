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

// Same-session init preserves exchanges; replacement drops prior work before publishing the new session to listeners.
export type BridgeClientShellSession = {
  current: () => BridgeShellSession | null
  accept: (message: InitMessage) => void
  onReady: (listener: () => void) => () => void
  onRouteUpdate: (listener: (route: BridgeInitRoute | null) => void) => () => void
  onSafeAreaInsetsUpdate: (listener: (insets: BridgeSafeAreaInsets) => void) => () => void
  onKeyboardInsetUpdate: (listener: (height: number) => void) => () => void
  onColorSchemeUpdate: (listener: (scheme: BridgeColorScheme) => void) => () => void
  onUiLocaleUpdate: (listener: (locale: BridgeUiLocale | null) => void) => () => void
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
      const colorScheme = message.colorScheme ?? 'dark'
      const movedScheme = held !== null && held.colorScheme !== colorScheme
      const uiLocale = message.uiLocale ?? null
      const movedUiLocale = held !== null && held.uiLocale !== uiLocale
      session =
        update === null
          ? { ...readShellSession(message), safeAreaInsets }
          : {
              ...update,
              route: message.route ?? null,
              safeAreaInsets,
              keyboardInset,
              colorScheme,
              uiLocale
            }
      // Reprime on every init to repair refused stale generations after client rebuild; identical pane-update snapshots emit no transition.
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
      // Publish only changed routes; repeated ready used for state repair must not retrigger the current pane.
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
