import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LayoutChangeEvent } from 'react-native'

type Geometry = { scope: string; height: number; viewport: number }
const LAYOUT_QUIET_MS = 200
const MAX_INITIAL_LAYOUT_WAIT_MS = 1_000

/** Hide native measurement and the tail pin, without depending on optional scroll events. */
export function useMobileNativeChatInitialLayout(
  scope: string,
  hasItems: boolean,
  pending = false
) {
  const geometry = useRef<Geometry>({ scope, height: 0, viewport: 0 })
  const [revision, setRevision] = useState(0)
  const [revealed, setRevealed] = useState<Geometry | null>(null)
  const [expired, setExpired] = useState<Geometry | null>(null)
  if (geometry.current.scope !== scope) {
    geometry.current = { scope, height: 0, viewport: 0 }
  }
  const measured = geometry.current
  const ready = !hasItems || revealed === measured
  const timedOut = expired === measured
  const waiting = pending && !timedOut
  useLayoutEffect(() => {
    if (ready || waiting || measured.height <= 0 || measured.viewport <= 0) {
      return
    }
    let frame: number | null = null
    // Give the queued tail pin two frames after the measured layout settles.
    const timer = setTimeout(
      () => {
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            if (geometry.current === measured && measured.height > 0 && measured.viewport > 0) {
              setRevealed(measured)
            }
          })
        })
      },
      timedOut ? 0 : LAYOUT_QUIET_MS
    )
    return () => {
      clearTimeout(timer)
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [ready, waiting, measured, revision, timedOut])
  useEffect(() => {
    if (ready) {
      return
    }
    // Live output and slow WebViews must not keep restarting the initial wait.
    const timer = setTimeout(() => setExpired(measured), MAX_INITIAL_LAYOUT_WAIT_MS)
    return () => clearTimeout(timer)
  }, [ready, measured])
  const record = useCallback(
    (dimension: 'height' | 'viewport', height: number) => {
      if (geometry.current !== measured || measured[dimension] === height) {
        return
      }
      const needsMeasurement = measured.height <= 0 || measured.viewport <= 0
      measured[dimension] = height
      if (!ready && (!timedOut || needsMeasurement)) {
        setRevision((current) => current + 1)
      }
    },
    [measured, ready, timedOut]
  )
  return {
    ready,
    recordLayout: useCallback(
      (event: LayoutChangeEvent) => record('viewport', event.nativeEvent.layout.height),
      [record]
    ),
    recordContent: useCallback((height: number) => record('height', height), [record])
  }
}
