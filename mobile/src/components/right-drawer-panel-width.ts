// Pure X-axis panel-width resolution for RightDrawer, kept native-import-free so
// it is unit-testable under the node Vitest config (no RN render harness exists).

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
    return Math.min(widthPx, windowWidth)
  }
  if (isWideLayout) {
    return Math.min(WIDE_PANEL_MAX_WIDTH, windowWidth)
  }
  return Math.max(windowWidth - NARROW_BACKDROP_GUTTER, 0)
}
