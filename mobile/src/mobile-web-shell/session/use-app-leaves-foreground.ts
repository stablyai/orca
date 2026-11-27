import { useEffect, useLayoutEffect, useRef } from 'react'
import { AppState, Platform } from 'react-native'

/**
 * Calls `onLeave` once each time the app leaves the foreground, before the system can kill it from the app
 * switcher. iOS: `inactive` (the app switcher, Notification Centre, Face ID); a page is hidden only once the app
 * reaches the background, which a swipe-kill can skip. Android: window `blur` (Recents, the notification shade, and
 * the app's own dialogs and sheets), because Recents leaves the activity resumed until the swipe kills the process.
 * Callers must keep the work cheap and idempotent: it runs on every such flap.
 * Not covered: on Android, Recents opened over one of the app's own sheets sends nothing more (the sheet's blur
 * already did), so rows streamed in while the sheet was open wait for the next save.
 */
export function useAppLeavesForeground(onLeave: () => void): void {
  const onLeaveRef = useRef(onLeave)
  useLayoutEffect(() => {
    onLeaveRef.current = onLeave
  }, [onLeave])
  useEffect(() => {
    let away = AppState.currentState !== 'active'
    const leave = (): void => {
      if (!away) {
        away = true
        onLeaveRef.current()
      }
    }
    const back = (): void => {
      away = false
    }
    const change = AppState.addEventListener('change', (next) =>
      next === 'active' ? back() : leave()
    )
    // Window focus events come from Android only; iOS's RCTAppState rejects the subscription outright
    // (a red screen in development), so it is never made there.
    const windowFocus =
      Platform.OS === 'android'
        ? [AppState.addEventListener('blur', leave), AppState.addEventListener('focus', back)]
        : []
    return () => {
      change.remove()
      for (const subscription of windowFocus) {
        subscription.remove()
      }
    }
  }, [])
}
