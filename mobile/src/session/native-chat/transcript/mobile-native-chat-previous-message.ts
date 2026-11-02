/** A stop already this close to the viewport top counts as aligned, so the next tap steps back. */
export const PREVIOUS_MESSAGE_ALIGN_PX = 8

export type PreviousMessageStop = {
  key: string
  /** Top relative to the viewport top. Absent when the row is not drawn yet. */
  top?: number
}

/**
 * Stops are user and assistant messages: the boundaries a reader walks.
 * Tool, reasoning, and system rows sit inside a turn. Joined or folded rows are not drawn.
 */
export function isPreviousMessageStop(
  role: string,
  row: { joinsWorkRun?: boolean; foldedAway?: boolean }
): boolean {
  return (
    (role === 'user' || role === 'assistant') &&
    row.joinsWorkRun !== true &&
    row.foldedAway !== true
  )
}

export type PreviousMessageTarget = { key: string } | { pendingKey: string }

/**
 * Nearest drawn stop above the viewport, past the align threshold.
 * Stops are in document order. An undrawn stop before the first measured one, or in
 * the hole before the first in-view measured stop, is pending so the list can draw it.
 * A trailing undrawn stop does not hide a measured one. Nothing measured stays unknown.
 */
export function previousMessageTarget(
  stops: readonly PreviousMessageStop[],
  threshold = PREVIOUS_MESSAGE_ALIGN_PX
): PreviousMessageTarget | null {
  let nearest: { key: string; top: number } | null = null
  let pendingKey: string | null = null
  let holeKey: string | null = null
  let seenMeasured = false
  for (const stop of stops) {
    if (stop.top === undefined) {
      if (!seenMeasured) {
        pendingKey = stop.key
      } else if (nearest) {
        holeKey = stop.key
      }
      continue
    }
    seenMeasured = true
    if (stop.top < -threshold) {
      nearest = { key: stop.key, top: stop.top }
      pendingKey = null
      holeKey = null
      continue
    }
    if (holeKey !== null) {
      return { pendingKey: holeKey }
    }
    break
  }
  if (nearest) {
    return { key: nearest.key }
  }
  if (pendingKey !== null && seenMeasured) {
    return { pendingKey }
  }
  return null
}

/**
 * Unmounted stop between the last measured above-fold stop and the first visible row.
 * Its index is still above the viewport, so scrolling to the older offset would skip it.
 */
export function trailingStopAboveViewport(
  stops: readonly PreviousMessageStop[],
  chosenKey: string,
  indexOf: (key: string) => number,
  firstVisibleIndex: number
): string | null {
  let passed = false
  let pending: string | null = null
  for (const stop of stops) {
    if (!passed) {
      if (stop.key === chosenKey) {
        passed = true
      }
      continue
    }
    if (stop.top !== undefined) {
      break
    }
    const index = indexOf(stop.key)
    if (index < 0) {
      continue
    }
    if (index >= firstVisibleIndex) {
      break
    }
    pending = stop.key
  }
  return pending
}

/**
 * Pose once `alignedKey` sits on the viewport top. Relative tops stay put, so a second tap
 * during the jump steps from the destination instead of the in-between offset.
 */
export function stopsAsIfAligned(
  stops: readonly PreviousMessageStop[],
  alignedKey: string
): PreviousMessageStop[] | null {
  const aligned = stops.find((stop) => stop.key === alignedKey)
  if (aligned?.top === undefined) {
    return null
  }
  const shift = aligned.top
  return stops.map((stop) =>
    stop.top === undefined ? stop : { key: stop.key, top: stop.top - shift }
  )
}

/** The previous message after `fromKey` has been brought to the viewport top. */
export function previousMessageChained(
  stops: readonly PreviousMessageStop[],
  fromKey: string
): PreviousMessageTarget | null {
  const posed = stopsAsIfAligned(stops, fromKey)
  if (posed) {
    return previousMessageTarget(posed)
  }
  const index = stops.findIndex((stop) => stop.key === fromKey)
  if (index <= 0) {
    return null
  }
  const earlier = stops[index - 1]
  if (!earlier) {
    return null
  }
  return earlier.top === undefined ? { pendingKey: earlier.key } : { key: earlier.key }
}

/** End-anchored scrollTop: more negative moves toward older rows. `rowTop` and `viewTop` share a viewport. */
export function endAnchoredScrollTopForRow(
  scrollTop: number,
  rowTop: number,
  viewTop: number
): number {
  return scrollTop + (rowTop - viewTop)
}
