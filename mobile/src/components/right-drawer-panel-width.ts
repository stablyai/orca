// Keep RightDrawer width resolution RN-free for Node tests.

// Why: cap the panel on wide canvases so it doesn't stretch across a tablet.
export const WIDE_PANEL_MAX_WIDTH = 420
// Why: on a phone the panel leaves a thin gutter so the backdrop stays tappable.
export const NARROW_BACKDROP_GUTTER = 48

export function resolveRightDrawerPanelWidth(
  windowWidth: number,
  isWideLayout: boolean,
  widthPx: number | undefined
): number {
  if (widthPx != null) {
    // Clamp to [0, windowWidth] so a negative explicit width can't yield a negative panel.
    return Math.max(Math.min(widthPx, windowWidth), 0)
  }
  if (isWideLayout) {
    return Math.min(WIDE_PANEL_MAX_WIDTH, windowWidth)
  }
  return Math.max(windowWidth - NARROW_BACKDROP_GUTTER, 0)
}
