import { useState } from 'react'

// Each mounted terminal holds an xterm buffer; three covers a split pair plus the last one left.
const MOUNTED_TERMINAL_LIMIT = 3

/** Visible terminals, then the most recently visible others, up to the limit; the rest unmount. */
export function nextMountedTerminalHandles(
  previous: readonly string[],
  visible: readonly string[],
  live: readonly string[]
): readonly string[] {
  const next = visible.filter((handle) => live.includes(handle))
  for (const handle of previous) {
    if (next.length >= MOUNTED_TERMINAL_LIMIT) {
      break
    }
    if (!next.includes(handle) && live.includes(handle)) {
      next.push(handle)
    }
  }
  const unchanged =
    next.length === previous.length && next.every((handle, index) => handle === previous[index])
  return unchanged ? previous : next
}

export function useMountedTerminalHandles(
  visible: readonly string[],
  live: readonly string[]
): readonly string[] {
  const [mounted, setMounted] = useState<readonly string[]>([])
  const next = nextMountedTerminalHandles(mounted, visible, live)
  if (next !== mounted) {
    setMounted(next)
  }
  return next
}
