import { useCallback, useState } from 'react'

export const BUILD_ID_PREFIX_LENGTH = 12

export type MobileWebShellDevFacts = {
  buildId: string
  totalBytes: number
  elapsedMs: number
  droppedBinaryFrames: number
}

// Show drop totals because a once-per-host diagnostic cannot distinguish repeated shedding; omit zero to keep changes noticeable. Never expose full build/host ids or paths on shared screens.
export function formatMobileWebShellDevFacts(facts: MobileWebShellDevFacts): string {
  const line = `${facts.buildId.slice(0, BUILD_ID_PREFIX_LENGTH)} · ${facts.totalBytes} B · ${facts.elapsedMs} ms`
  if (facts.droppedBinaryFrames === 0) {
    return line
  }
  const frames = facts.droppedBinaryFrames === 1 ? 'frame' : 'frames'
  return `${line} · ${facts.droppedBinaryFrames} ${frames} dropped`
}

// Guard absent __DEV__ outside RN and read it at use time so tests need not set the global before import.
export function isDevelopmentBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__
}

// Only development builds render this total; avoid release-build rerenders on every drop and keep the reporter stable so it cannot rebuild the bridge.
export function useMobileWebShellDroppedFrames(): {
  droppedBinaryFrames: number
  reportDroppedBinaryFrames: (total: number) => void
} {
  const [droppedBinaryFrames, setDroppedBinaryFrames] = useState(0)
  const reportDroppedBinaryFrames = useCallback((total: number) => {
    if (isDevelopmentBuild()) {
      setDroppedBinaryFrames(total)
    }
  }, [])
  return { droppedBinaryFrames, reportDroppedBinaryFrames }
}
