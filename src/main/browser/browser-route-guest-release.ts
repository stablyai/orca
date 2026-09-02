import { browserRoutePageKey } from './browser-route-page-authority'
import type { BrowserRouteGuestState } from './browser-route-webcontents-state'

export function releaseBrowserRouteGuest(
  state: BrowserRouteGuestState,
  guests: Map<number, BrowserRouteGuestState>,
  guestsByPage: Map<string, BrowserRouteGuestState>
): void {
  if (guests.get(state.guest.id) === state) {
    guests.delete(state.guest.id)
  }
  if (state.registration) {
    const pageKey = browserRoutePageKey(state.registration)
    if (guestsByPage.get(pageKey) === state) {
      guestsByPage.delete(pageKey)
    }
  }
  try {
    state.guest.off('will-navigate', state.onNavigate)
  } catch {}
  try {
    state.guest.off('will-redirect', state.onNavigate)
  } catch {}
  try {
    state.guest.off('render-process-gone', state.onRenderProcessGone)
  } catch {}
  try {
    state.guest.off('destroyed', state.onDestroyed)
  } catch {}
  state.popups?.dispose()
  state.popups = null
  const callback = state.retirementCallback
  state.retirementCallback = null
  state.resolveDestroyed()
  if (callback) {
    try {
      callback()
    } catch {}
  }
}
