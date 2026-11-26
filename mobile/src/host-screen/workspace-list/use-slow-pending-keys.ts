import { useEffect, useMemo, useRef, useState } from 'react'

export const SLOW_PENDING_MS = 500

const NONE: ReadonlySet<string> = new Set()

export function useSlowPendingKeys(
  pendingKeys: ReadonlySet<string>,
  delayMs: number = SLOW_PENDING_MS
): ReadonlySet<string> {
  const pendingSinceRef = useRef(new Map<string, number>())
  const [slowKeys, setSlowKeys] = useState<ReadonlySet<string>>(NONE)

  useEffect(() => {
    const pendingSince = pendingSinceRef.current
    const now = Date.now()
    for (const key of pendingSince.keys()) {
      if (!pendingKeys.has(key)) {
        pendingSince.delete(key)
      }
    }
    // Why prune: a settled key that goes pending again must wait out the delay afresh.
    setSlowKeys((prev) => {
      const kept = [...prev].filter((key) => pendingKeys.has(key))
      return kept.length === prev.size ? prev : new Set(kept)
    })
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const key of pendingKeys) {
      const since = pendingSince.get(key) ?? now
      pendingSince.set(key, since)
      timers.push(
        setTimeout(
          () => setSlowKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key))),
          Math.max(0, since + delayMs - now)
        )
      )
    }
    return () => timers.forEach(clearTimeout)
  }, [pendingKeys, delayMs])

  // Why intersect: a key that settled hides on this render, not after the effect's prune.
  return useMemo(() => {
    const visible = [...slowKeys].filter((key) => pendingKeys.has(key))
    return visible.length === slowKeys.size ? slowKeys : new Set(visible)
  }, [slowKeys, pendingKeys])
}
