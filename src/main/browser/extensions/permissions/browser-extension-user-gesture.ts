import type { BrowserExtensionCaller } from '../api-runtime/browser-extension-namespace-registry'
import { getHostSessionState } from '../api-runtime/browser-extension-contexts'
import { getBrowserExtensionContextSignal } from '../api-runtime/browser-extension-context-lifetime'

export const BROWSER_EXTENSION_USER_GESTURE_WINDOW_MS = 5_000

const recentGestures = new WeakMap<AbortSignal, number>()

/**
 * Chrome lets permissions.request run only inside a user gesture. Orca records the gestures it
 * delivers to an extension (menu click, command, notification click, toolbar click).
 */
export function noteBrowserExtensionUserGesture(
  session: Electron.Session,
  extensionId: string
): void {
  const state = getHostSessionState(session)
  if (!state) {
    return
  }
  const signal = getBrowserExtensionContextSignal(state, extensionId)
  recentGestures.set(signal, Date.now())
}

/** When Orca last handed the caller's extension a gesture, if still within the gesture window. */
export function getBrowserExtensionUserGestureAt(caller: BrowserExtensionCaller): number | null {
  const state = getHostSessionState(caller.session)
  if (!state) {
    return null
  }
  const signal = getBrowserExtensionContextSignal(state, caller.extension.id)
  const at = recentGestures.get(signal)
  return at !== undefined &&
    !signal.aborted &&
    Date.now() - at <= BROWSER_EXTENSION_USER_GESTURE_WINDOW_MS
    ? at
    : null
}

export function hasBrowserExtensionUserGesture(caller: BrowserExtensionCaller): boolean {
  return caller.userGesture === true || getBrowserExtensionUserGestureAt(caller) !== null
}
