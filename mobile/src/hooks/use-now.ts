import { useEffect, useRef, useState } from 'react'
import { useAppActive } from './use-app-active'

// A list-level caller's single tick drives every visible relative-time label.
export function useNow(intervalMs = 30_000, enabled = true): number {
  const appActive = useAppActive()
  const running = appActive && enabled
  const [now, setNow] = useState(() => Date.now())
  const wasRunningRef = useRef(running)

  useEffect(() => {
    const resumed = running && !wasRunningRef.current
    wasRunningRef.current = running
    if (!running) {
      return
    }
    if (resumed) {
      setNow(Date.now())
    }
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, running])

  return now
}
