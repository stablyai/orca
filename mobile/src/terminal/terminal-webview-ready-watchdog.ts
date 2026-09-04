import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { AppState } from 'react-native'

// Why: if the document dies before the glue can post anything (or the RN
// message bridge never comes up), no webview error and no native handler
// fires — without a native watchdog that failure is a silent blank pane.
const WEB_READY_WATCHDOG_MS = 15000

export function useTerminalWebReadyWatchdog(
  isWebReadyRef: RefObject<boolean>,
  reportEngineError: (message: string, fatal: boolean) => void,
  probeBeforeError?: () => void
) {
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const probedRef = useRef(false)

  const clearWebReadyWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }, [])

  const armWebReadyWatchdog = useCallback(() => {
    clearWebReadyWatchdog()
    probedRef.current = false
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
      if (probeBeforeError && !probedRef.current) {
        // Why: iOS can hand back a live document whose ready signal was lost in a
        // transition — an app switch cures it instantly via ping/pong, so try that
        // cure once before surfacing a reload prompt that cannot help.
        probedRef.current = true
        probeBeforeError()
        return
      }
      reportEngineError(
        'Terminal did not initialize - no ready signal from the terminal view',
        true
      )
    }
    watchdogRef.current = setTimeout(fire, WEB_READY_WATCHDOG_MS)
  }, [clearWebReadyWatchdog, isWebReadyRef, probeBeforeError, reportEngineError])

  useEffect(() => {
    armWebReadyWatchdog()
    return clearWebReadyWatchdog
  }, [armWebReadyWatchdog, clearWebReadyWatchdog])

  return { armWebReadyWatchdog, clearWebReadyWatchdog }
}
