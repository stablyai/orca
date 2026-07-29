import type { Screen, Display } from 'electron'

export type StatusPillPlacementInput = {
  /** Pill width in CSS pixels (device-independent). */
  pillWidth: number
  /** Pill height in CSS pixels (device-independent). */
  pillHeight: number
  /** Display the pill should anchor to. Caller picks via cursor or pinning. */
  display: Display
  /** OS platform branch; decides notch-aware vs. plain top-center anchor. */
  platform: NodeJS.Platform
  /** Optional user-pinned horizontal offset within the display's work area.
   *  When undefined, the pill centers horizontally. */
  pinnedXOffset?: number
}

export type StatusPillPlacement = {
  x: number
  y: number
  width: number
  height: number
}

/** Top gap (CSS px) below the work-area top edge on platforms without a notch.
 *  Matches Vibe Island's compact floating-bar fallback on external displays. */
const TOP_GAP_NO_NOTCH = 8

/** Notch-aware extra gap on macOS so the pill drops just below the notch
 *  inset instead of butting against it. */
const TOP_GAP_NOTCH_MAC = 6

/** Minimum work-area top inset (CSS px) that we treat as evidence of a notch
 *  on the primary macOS display. Newer Electron exposes `safeArea`; on builds
 *  without it, this heuristic preserves notch-aware placement. */
const MAC_NOTCH_HEURISTIC_MIN_INSET = 24

export function hasMacNotch(
  display: Display,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'darwin') {
    return false
  }
  // Why: safeArea is the Electron 43+ notch-aware metric. Some older builds
  // ship without it; the workArea.y heuristic catches the same case for them.
  const safeArea = (display as Display & { safeArea?: Electron.Rectangle }).safeArea
  if (safeArea && typeof safeArea.y === 'number') {
    return safeArea.y >= MAC_NOTCH_HEURISTIC_MIN_INSET
  }
  return display.workArea.y >= MAC_NOTCH_HEURISTIC_MIN_INSET
}

/** Decide which display the pill should anchor to. Returns the chosen display
 *  from the provided list using the cursor position, falling back to the
 *  primary display when the cursor cannot be matched or the screen API is
 *  unavailable (tests, headless). */
export function pickDisplayForCursor(
  displays: Display[],
  cursor: { x: number; y: number } | null
): Display | null {
  if (displays.length === 0) {
    return null
  }
  if (cursor) {
    const match = displays.find((d) => {
      const { x, y, width, height } = d.bounds
      return cursor.x >= x && cursor.x < x + width && cursor.y >= y && cursor.y < y + height
    })
    if (match) {
      return match
    }
  }
  return displays.find((d) => d.internal) ?? displays[0]
}

/** Window-level padding around the capsule so the box-shadow halo has room to
 *  render outside the .pill body without being clipped by the BrowserWindow
 *  bounds. Exported so the renderer can mirror the values in its own CSS
 *  (the .pill-stack wrapper inset must match for the capsule to visually
 *  center inside the window). */
export const PILL_WINDOW_PADDING_X = 18
export const PILL_WINDOW_PADDING_TOP = 6
export const PILL_WINDOW_PADDING_BOTTOM = 34

/** Compute the pill window's rectangle for a user-pinned position, clamped
 *  into the work area of the display that contains the point. The `point` is
 *  the desired window origin (what the drag persists via window.getPosition),
 *  so the returned rectangle covers the full window (capsule + padding). If
 *  the point's display is gone (monitor unplugged), it falls back to the
 *  primary/internal display so the pill is never stranded off-screen. Returns
 *  null when there are no displays. */
export function computeStatusPillPlacementForPoint(input: {
  displays: Display[]
  point: { x: number; y: number }
  pillWidth: number
  pillHeight: number
}): { x: number; y: number; width: number; height: number } | null {
  const { displays, point, pillWidth, pillHeight } = input
  if (displays.length === 0) {
    return null
  }
  // Why: the point is the window origin; clamp the full window rectangle
  // (capsule + padding) so the capsule + shadow halo never leave the display.
  const windowWidth = pillWidth + PILL_WINDOW_PADDING_X * 2
  const windowHeight = pillHeight + PILL_WINDOW_PADDING_TOP + PILL_WINDOW_PADDING_BOTTOM
  // Why: pickDisplayForCursor already resolves "the display whose bounds
  // contain this point", with a sensible internal/first fallback, so we reuse
  // it for the pinned point.
  const display = pickDisplayForCursor(displays, point) ?? displays[0]
  const workArea = display.workArea
  const x = clamp(point.x, workArea.x, workArea.x + Math.max(0, workArea.width - windowWidth))
  const y = clamp(point.y, workArea.y, workArea.y + Math.max(0, workArea.height - windowHeight))
  return { x, y, width: windowWidth, height: windowHeight }
}

/** Compute the pill window's screen rectangle for the chosen display +
 *  platform. The rectangle covers the *window* (capsule + padding), so the
 *  capsule body is centered inside the returned bounds and the box-shadow halo
 *  has room to render outside the capsule without being clipped. */
export function computeStatusPillPlacement(input: StatusPillPlacementInput): StatusPillPlacement {
  const { pillWidth, pillHeight, display, platform, pinnedXOffset } = input
  const workArea = display.workArea

  // Why: window = capsule + horizontal padding, so the capsule stays centered
  // and the shadow halo has room on each side. Centering uses the WINDOW width
  // so the visible capsule ends up visually centered on the display.
  const windowWidth = pillWidth + PILL_WINDOW_PADDING_X * 2
  const windowHeight = pillHeight + PILL_WINDOW_PADDING_TOP + PILL_WINDOW_PADDING_BOTTOM
  const centerX = workArea.x + Math.round((workArea.width - windowWidth) / 2)
  const minX = workArea.x + TOP_GAP_NO_NOTCH
  const maxX = workArea.x + workArea.width - windowWidth - TOP_GAP_NO_NOTCH
  const resolvedX =
    typeof pinnedXOffset === 'number'
      ? clamp(pinnedXOffset, minX, maxX)
      : clamp(centerX, minX, maxX)

  const y = computeTopY({ platform, display, pillHeight })

  return {
    x: resolvedX,
    y,
    width: windowWidth,
    height: windowHeight
  }
}

function computeTopY(args: {
  platform: NodeJS.Platform
  display: Display
  pillHeight: number
}): number {
  if (args.platform === 'darwin' && hasMacNotch(args.display, args.platform)) {
    // Why: on a notched MacBook the pill drops just below the notch inset.
    // workArea already excludes the notch region, so we add a small visual
    // gap on top of it.
    return args.display.workArea.y + TOP_GAP_NOTCH_MAC
  }
  return args.display.workArea.y + TOP_GAP_NO_NOTCH
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.max(min, Math.min(max, Math.round(value)))
}

/** Live cursor accessor that does not throw when Electron's screen API is
 *  unavailable (tests, headless). Returns null instead. */
export function getCursorScreenPointSafe(screen: Pick<Screen, 'getCursorScreenPoint'>): {
  x: number
  y: number
} | null {
  try {
    const p = screen.getCursorScreenPoint()
    if (typeof p?.x === 'number' && typeof p?.y === 'number') {
      return { x: p.x, y: p.y }
    }
  } catch {
    // Best-effort; treat as no cursor.
  }
  return null
}
