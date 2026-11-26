import { useEffect, useState } from 'react'
import { getResetCountdownNextTickDelay } from '../../../src/shared/agent-usage/rate-limits/rate-limit-reset-format'
import { useAppActive } from '../hooks/use-now'

const MAX_TICK_MS = 60_000

/**
 * The time for reset countdowns: ticks just past each label's next change ("6d 17h" → "6d 16h"),
 * so every countdown flips together, and at least every minute.
 */
export function useResetCountdownNow(resetTimes: readonly number[]): number {
  const appActive = useAppActive()
  const [now, setNow] = useState(() => Date.now())
  const key = resetTimes.join(',')
  useEffect(() => {
    if (!appActive) {
      return
    }
    const resets = key ? key.split(',').map(Number) : []
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = (): void => {
      const current = Date.now()
      setNow(current)
      const delay = getResetCountdownNextTickDelay(current, resets) ?? MAX_TICK_MS
      timer = setTimeout(tick, Math.min(delay, MAX_TICK_MS))
    }
    // A new reading or a return to the foreground reads the clock afresh, not a minute-old one.
    tick()
    return () => clearTimeout(timer)
  }, [appActive, key])
  return now
}
