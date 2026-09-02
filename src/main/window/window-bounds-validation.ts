import { screen } from 'electron'

export type WindowRect = { x: number; y: number; width: number; height: number }

/**
 * True when `rect` overlaps some currently-attached display's workArea by at
 * least the given visible width/height. Used to reject persisted bounds that
 * would restore a window off-screen — e.g. saved while an external monitor was
 * connected. workArea excludes the menu bar / dock, so a rect hidden entirely
 * under the dock is also correctly rejected. Requiring a *meaningful* overlap
 * (not just >0) avoids a one-pixel sliver leaving the titlebar unreachable.
 */
export function rectHasVisibleAreaOnAnyDisplay(
  rect: WindowRect,
  minVisibleWidth: number,
  minVisibleHeight: number
): boolean {
  try {
    return screen.getAllDisplays().some((display) => {
      const wa = display.workArea
      const overlapX = Math.max(
        0,
        Math.min(rect.x + rect.width, wa.x + wa.width) - Math.max(rect.x, wa.x)
      )
      const overlapY = Math.max(
        0,
        Math.min(rect.y + rect.height, wa.y + wa.height) - Math.max(rect.y, wa.y)
      )
      return overlapX >= minVisibleWidth && overlapY >= minVisibleHeight
    })
  } catch (err) {
    console.warn('[window] screen.getAllDisplays() threw; treating bounds as off-screen', err)
    return false
  }
}
