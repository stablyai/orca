import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { AppState } from 'react-native'

// Why: if the document dies before the glue can post anything (or the RN
// message bridge never comes up), no webview error and no native handler
// fires — without a native watchdog that failure is a silent blank pane.
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
        // Why: backgrounded WebViews legitimately stall; only judge foreground loads.
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
