import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { AppState } from 'react-native'

// Why: if the document dies before the glue can post anything (or the RN
// message bridge never comes up), no webview error and no native handler
// fires — without a native watchdog that failure is a silent blank pane.
const WEB_READY_WATCHDOG_MS = 15000

export const TERMINAL_WEB_READY_UNMET =
  'Terminal did not initialize - no ready signal from the terminal view'
export const TERMINAL_PAINT_READY_UNMET =
  'Terminal did not paint - no init ready from the terminal view'

type TerminalReadinessWatchdogOptions = {
  isSatisfiedRef: RefObject<boolean>
  probeBeforeError?: () => void
  reportEngineError: (message: string, fatal: boolean) => void
  unmetMessage: string
}

function useTerminalReadinessWatchdog({
  isSatisfiedRef,
  probeBeforeError,
  reportEngineError,
  unmetMessage
}: TerminalReadinessWatchdogOptions) {
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const probedRef = useRef(false)

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }, [])

  const armWatchdog = useCallback(() => {
    clearWatchdog()
    probedRef.current = false
    const fire = () => {
      watchdogRef.current = null
      if (isSatisfiedRef.current) {
        return
      }
      if (AppState.currentState !== 'active') {
        // Why: backgrounded WebViews legitimately stall; only judge foreground loads.
        watchdogRef.current = setTimeout(fire, WEB_READY_WATCHDOG_MS)
        return
      }
      if (probeBeforeError && !probedRef.current) {
        // Why: iOS can hand back a live document whose signal was lost in a
        // transition — an app switch cures it instantly via ping/pong, so try that
        // cure once before surfacing a reload prompt that cannot help.
        probedRef.current = true
        probeBeforeError()
        return
      }
      reportEngineError(unmetMessage, true)
    }
    watchdogRef.current = setTimeout(fire, WEB_READY_WATCHDOG_MS)
  }, [clearWatchdog, isSatisfiedRef, probeBeforeError, reportEngineError, unmetMessage])

  useEffect(() => clearWatchdog, [clearWatchdog])

  return { armWatchdog, clearWatchdog }
}

export function useTerminalWebReadyWatchdog(
  isWebReadyRef: RefObject<boolean>,
  reportEngineError: (message: string, fatal: boolean) => void,
  probeBeforeError?: () => void
) {
  const { armWatchdog, clearWatchdog } = useTerminalReadinessWatchdog({
    isSatisfiedRef: isWebReadyRef,
    probeBeforeError,
    reportEngineError,
    unmetMessage: TERMINAL_WEB_READY_UNMET
  })

  // Why: the first document has no other arming edge — later ones arm from onLoadStart.
  useEffect(() => {
    armWatchdog()
  }, [armWatchdog])

  return { armWebReadyWatchdog: armWatchdog, clearWebReadyWatchdog: clearWatchdog }
}

// Why: web-ready proves the script runs, not that the terminal painted. If init's 'ready'
// is lost, the surface gate never opens and nothing else notices — no ping, no overlay,
// a terminal that stays hidden until an app switch. Armed by init() rather than by
// readiness, because a pane the session never subscribed to legitimately never inits.
export function useTerminalPaintReadyWatchdog(
  isSurfacePaintedRef: RefObject<boolean>,
  reportEngineError: (message: string, fatal: boolean) => void,
  probeBeforeError?: () => void
) {
  const { armWatchdog, clearWatchdog } = useTerminalReadinessWatchdog({
    isSatisfiedRef: isSurfacePaintedRef,
    probeBeforeError,
    reportEngineError,
    unmetMessage: TERMINAL_PAINT_READY_UNMET
  })

  return { armPaintReadyWatchdog: armWatchdog, clearPaintReadyWatchdog: clearWatchdog }
}
