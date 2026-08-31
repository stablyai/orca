import { useEffect, useState } from 'react'

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
