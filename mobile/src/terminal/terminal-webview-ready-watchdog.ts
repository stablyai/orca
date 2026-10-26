import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { AppState } from 'react-native'

// Silent startup/bridge failures may emit no error; a native watchdog must turn the blank pane into a reported failure.
const WEB_READY_WATCHDOG_MS = 15000

export function useTerminalWebReadyWatchdog(
  isWebReadyRef: RefObject<boolean>,
  reportEngineError: (message: string, fatal: boolean) => void
) {
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearWebReadyWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }, [])

  const armWebReadyWatchdog = useCallback(() => {
    clearWebReadyWatchdog()
    const fire = () => {
      watchdogRef.current = null
      if (isWebReadyRef.current) {
        return
      }
      if (AppState.currentState !== 'active') {
        // Background WebViews may legitimately stall; judge readiness only in foreground.
        watchdogRef.current = setTimeout(fire, WEB_READY_WATCHDOG_MS)
        return
      }
      reportEngineError(
        'Terminal did not initialize - no ready signal from the terminal view',
        true
      )
    }
    watchdogRef.current = setTimeout(fire, WEB_READY_WATCHDOG_MS)
  }, [clearWebReadyWatchdog, isWebReadyRef, reportEngineError])

  useEffect(() => {
    armWebReadyWatchdog()
    return clearWebReadyWatchdog
  }, [armWebReadyWatchdog, clearWebReadyWatchdog])

  return { armWebReadyWatchdog, clearWebReadyWatchdog }
}
