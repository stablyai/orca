// The one rule for a new terminal's first size.

export type PtyGridSize = { cols: number; rows: number }

// Why 120x40: #1707's original size, kept for a terminal no window has measured (serve, orcad).
export const UNMEASURED_PTY_SIZE: PtyGridSize = { cols: 120, rows: 40 }

function isMeasured(size: PtyGridSize | undefined): size is PtyGridSize {
  return (
    size !== undefined &&
    Number.isInteger(size.cols) &&
    Number.isInteger(size.rows) &&
    size.cols > 0 &&
    size.rows > 0
  )
}

/**
 * The most specific measured size wins, so a terminal's first output isn't wrapped at a size its
 * pane never had: the caller's own pane, then the group the tab opens in, then a lone group.
 */
export function resolvePtyFirstSize(measured: {
  pane?: PtyGridSize
  group?: PtyGridSize
  singleGroup?: PtyGridSize
}): PtyGridSize {
  for (const size of [measured.pane, measured.group, measured.singleGroup]) {
    if (isMeasured(size)) {
      return size
    }
  }
  return UNMEASURED_PTY_SIZE
}
