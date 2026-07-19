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

export function computeStatusPillPlacement(input: StatusPillPlacementInput): StatusPillPlacement {
  const { pillWidth, pillHeight, display, platform, pinnedXOffset } = input
  const workArea = display.workArea

  // Why: horizontal placement is either user-pinned (within bounds) or centered
  // in the work area. Centering mirrors Vibe Island's notch anchor when the
  // display has a notch and looks correct on plain top-center platforms too.
  const centerX = workArea.x + Math.round((workArea.width - pillWidth) / 2)
  const minX = workArea.x + TOP_GAP_NO_NOTCH
  const maxX = workArea.x + workArea.width - pillWidth - TOP_GAP_NO_NOTCH
  const resolvedX =
    typeof pinnedXOffset === 'number'
      ? clamp(pinnedXOffset, minX, maxX)
      : clamp(centerX, minX, maxX)

  const y = computeTopY({ platform, display, pillHeight })

  return {
    x: resolvedX,
    y,
    width: pillWidth,
    height: pillHeight
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
