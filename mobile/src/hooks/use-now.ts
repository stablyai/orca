import { useEffect, useState } from 'react'

// One shared interval per caller, mirroring desktop's useNow: relative
// timestamps ("Xm") need a periodic re-render to stay honest. The worktree list
// owns a single tick that drives every visible agent row, rather than each row
// running its own interval.
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
