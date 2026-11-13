import { screen, type BrowserWindow } from 'electron'
import { rectOverlapsWorkArea, type WindowRect } from './presentation/window-bounds-validation'

// The strip a user grabs to move the window; usable means it is reachable on the cursor's display.
const TITLE_STRIP_HEIGHT = 32
const MIN_GRAB_WIDTH = 120

function cursorWorkArea(): WindowRect {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
}

/** Centered on the cursor's display, keeping the size unless it does not fit there. */
export function boundsOnCursorDisplay(width: number, height: number): WindowRect {
  const area = cursorWorkArea()
  const fitWidth = Math.min(width, area.width)
  const fitHeight = Math.min(height, area.height)
  return {
    x: area.x + Math.round((area.width - fitWidth) / 2),
    y: area.y + Math.round((area.height - fitHeight) / 2),
    width: fitWidth,
    height: fitHeight
  }
}

// Why not getDisplayMatching: it names the nearest display even for an off-screen window.
export function isUsableOnCursorDisplay(window: BrowserWindow): boolean {
  const titleStrip = { ...window.getBounds(), height: TITLE_STRIP_HEIGHT }
  return rectOverlapsWorkArea(titleStrip, cursorWorkArea(), MIN_GRAB_WIDTH, TITLE_STRIP_HEIGHT)
}

export function placeOnCursorDisplay(window: BrowserWindow): void {
  if (!isUsableOnCursorDisplay(window)) {
    const { width, height } = window.getBounds()
    window.setBounds(boundsOnCursorDisplay(width, height))
  }
}
