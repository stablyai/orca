import { useCallback, useEffect, useRef, useState } from 'react'

export type NativeAlertOpening<P> = { id: number; props: P }

/**
 * Snapshots the props each time `visible` turns on, so an alert's buttons answer the opening
 * on screen; `answer` runs once per opening and never after the caller withdrew it.
 */
export function useNativeAlertOpening<P>(
  visible: boolean,
  props: P,
  onWithdrawn?: (shown: P) => void
) {
  const [opening, setOpening] = useState<NativeAlertOpening<P> | null>(
    visible ? { id: 0, props } : null
  )
  const [wasVisible, setWasVisible] = useState(visible)
  if (visible !== wasVisible) {
    setWasVisible(visible)
    if (visible) {
      setOpening({ id: (opening?.id ?? -1) + 1, props })
    }
  }

  const answered = useRef<number | null>(null)
  const live = useRef(visible)
  const latestWithdrawn = useRef(onWithdrawn)
  useEffect(() => {
    latestWithdrawn.current = onWithdrawn
  })
  useEffect(() => {
    live.current = visible
    if (!visible && opening && answered.current !== opening.id) {
      answered.current = opening.id
      latestWithdrawn.current?.(opening.props)
    }
  }, [visible, opening])

  const answer = useCallback((id: number, respond: () => void) => {
    if (answered.current === id || !live.current) {
      return
    }
    answered.current = id
    respond()
  }, [])

  return { opening, answer }
}
