import { screen } from 'electron'

export type WindowRect = { x: number; y: number; width: number; height: number }

/** Meaningful overlap with one work area: a sliver of a window does not count. */
export function rectOverlapsWorkArea(
  rect: WindowRect,
  workArea: WindowRect,
  minVisibleWidth: number,
  minVisibleHeight: number
): boolean {
  const overlapX = Math.max(
    0,
    Math.min(rect.x + rect.width, workArea.x + workArea.width) - Math.max(rect.x, workArea.x)
  )
  const overlapY = Math.max(
    0,
    Math.min(rect.y + rect.height, workArea.y + workArea.height) - Math.max(rect.y, workArea.y)
  )
  return overlapX >= minVisibleWidth && overlapY >= minVisibleHeight
}

/** Require meaningful work-area overlap on a current display so removed monitors, dock coverage or one-pixel slivers cannot strand the titlebar. */
export function rectHasVisibleAreaOnAnyDisplay(
  rect: WindowRect,
  minVisibleWidth: number,
  minVisibleHeight: number
): boolean {
  try {
    return screen
      .getAllDisplays()
      .some((display) =>
        rectOverlapsWorkArea(rect, display.workArea, minVisibleWidth, minVisibleHeight)
      )
  } catch (err) {
    console.warn('[window] screen.getAllDisplays() threw; treating bounds as off-screen', err)
    return false
  }
}
