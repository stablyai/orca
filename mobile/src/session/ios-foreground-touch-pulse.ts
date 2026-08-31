import { useEffect, useState } from 'react'

// Why: tab switch unfreezes a notification-resume pane by flipping pointerEvents
// and opacity; stream recovery does not, so we recommit the wrapper for one frame.
export function useIosForegroundTouchPulse(epoch: number, enabled: boolean): boolean {
  const [committed, setCommitted] = useState(() => !(enabled && epoch > 0))
  useEffect(() => {
    if (!enabled || epoch <= 0) {
      setCommitted(true)
      return
    }
    setCommitted(false)
    const id = requestAnimationFrame(() => {
      setCommitted(true)
    })
    return () => cancelAnimationFrame(id)
  }, [epoch, enabled])
  return committed
}
