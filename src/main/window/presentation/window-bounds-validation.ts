import { screen } from 'electron'

export type WindowRect = { x: number; y: number; width: number; height: number }

/** Require meaningful work-area overlap on a current display so removed monitors, dock coverage or one-pixel slivers cannot strand the titlebar. */
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
