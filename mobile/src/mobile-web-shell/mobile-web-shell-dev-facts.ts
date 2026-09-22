import { useCallback, useState } from 'react'

/** Enough of the build id to tell two generations apart, and never enough to be one. */
export const BUILD_ID_PREFIX_LENGTH = 12

export type MobileWebShellDevFacts = {
  buildId: string
  totalBytes: number
  elapsedMs: number
  /** Screencast frames this session's bridge host could not carry, running total. */
  droppedBinaryFrames: number
}

/**
 * The line the shell paints over a development build, and the only place a dropped screencast frame
 * is visible on a device.
 *
 * The drop rule keeps a stream alive by shedding a frame the envelope will not carry, and the
 * diagnostic beside it prints once per host — so without this number a browser pane shedding a
 * frame a second and one that shed a single frame look identical from the outside. The suffix is
 * absent at zero rather than reading `0 dropped`, because a count that is always on screen is one
 * nobody notices changing.
 *
 * Never the generation directory, never the whole build id, never the host id: this renders on a
 * device someone may be screen-sharing, and none of those tell them anything a prefix does not.
 */
export function formatMobileWebShellDevFacts(facts: MobileWebShellDevFacts): string {
  const line = `${facts.buildId.slice(0, BUILD_ID_PREFIX_LENGTH)} · ${facts.totalBytes} B · ${facts.elapsedMs} ms`
  if (facts.droppedBinaryFrames === 0) {
    return line
  }
  const frames = facts.droppedBinaryFrames === 1 ? 'frame' : 'frames'
  return `${line} · ${facts.droppedBinaryFrames} ${frames} dropped`
}

/**
 * Same guard as the Troubleshoot developer row: `__DEV__` is undefined outside the React Native
 * runtime, and the line above is for whoever is bringing the shell up, not for a user.
 *
 * Read where it is used rather than frozen into a module constant at import. A build flag never
 * changes at runtime, so this costs nothing, and the constant form made the branch unreachable to
 * anything that did not set the global before the module loaded.
 */
export function isDevelopmentBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__
}

/**
 * The dropped-frame total, and the rule that it is only state where something renders it.
 *
 * The line above is the total's only reader and it renders nothing outside a development build, so
 * holding the number in React state there would re-render the whole shell screen once per dropped
 * frame — up to ten a second on a page the desktop cannot compress — for a fact no one can see.
 * The gate lives here rather than at the call site because this module owns both the line and the
 * reason the number exists at all.
 *
 * The reporter is stable, so the bridge host is never rebuilt for it.
 */
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
