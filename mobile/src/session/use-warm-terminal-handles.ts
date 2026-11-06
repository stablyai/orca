import { useEffect, useMemo, useState } from 'react'

export const MOBILE_TERMINAL_WARM_INACTIVE_LIMIT = 3

export function selectWarmTerminalHandles(args: {
  liveHandles: readonly string[]
  visibleHandles: readonly string[]
  recentHandles: readonly string[]
  warmInactiveLimit?: number
}): Set<string> {
  const limit = args.warmInactiveLimit ?? MOBILE_TERMINAL_WARM_INACTIVE_LIMIT
  const liveSet = new Set(args.liveHandles)
  const warm = new Set<string>()
  for (const handle of args.visibleHandles) {
    if (liveSet.has(handle)) {
      warm.add(handle)
    }
  }
  let inactiveCount = 0
  for (const handle of args.recentHandles) {
    if (inactiveCount >= limit) {
      break
    }
    if (liveSet.has(handle) && !warm.has(handle)) {
      warm.add(handle)
      inactiveCount += 1
    }
  }
  return warm
}

export function useWarmTerminalHandles(
  terminals: readonly { handle: string }[],
  visibleTerminalHandles: readonly string[] | undefined,
  activeHandle: string | null
): ReadonlySet<string> {
  const liveHandles = useMemo(() => terminals.map((terminal) => terminal.handle), [terminals])
  const visibleHandles = useMemo(
    () => visibleTerminalHandles ?? (activeHandle ? [activeHandle] : []),
    [activeHandle, visibleTerminalHandles]
  )
  const [recentHandles, setRecentHandles] = useState<readonly string[]>([])

  useEffect(() => {
    if (visibleHandles.length === 0) {
      return
    }
    setRecentHandles((previous) => {
      const liveSet = new Set(liveHandles)
      const next: string[] = []
      for (const handle of visibleHandles) {
        if (liveSet.has(handle) && !next.includes(handle)) {
          next.push(handle)
        }
      }
      for (const handle of previous) {
        if (liveSet.has(handle) && !next.includes(handle)) {
          next.push(handle)
        }
      }
      const trimmed = next.slice(0, visibleHandles.length + MOBILE_TERMINAL_WARM_INACTIVE_LIMIT)
      if (
        trimmed.length === previous.length &&
        trimmed.every((handle, index) => handle === previous[index])
      ) {
        return previous
      }
      return trimmed
    })
  }, [liveHandles, visibleHandles])

  return useMemo(
    () =>
      selectWarmTerminalHandles({
        liveHandles,
        visibleHandles,
        recentHandles
      }),
    [liveHandles, recentHandles, visibleHandles]
  )
}
