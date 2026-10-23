import { screen, type BrowserWindow } from 'electron'
import type { BrowserPageSwipe } from '../../shared/browser-page-command-target'

/**
 * macOS delivers three-finger swipes, and the back/forward buttons Logi Options+ turns into
 * swipes, only as a window event. The renderer finds the page under the cursor and navigates it.
 */
export function installMainWindowSwipeNavigation(mainWindow: BrowserWindow): void {
  mainWindow.on('swipe', (_event, direction) => {
    if (direction !== 'left' && direction !== 'right') {
      return
    }
    const cursor = screen.getCursorScreenPoint()
    const swipe: BrowserPageSwipe = {
      direction: direction === 'left' ? 'back' : 'forward',
      screenX: cursor.x,
      screenY: cursor.y
    }
    mainWindow.webContents.send('ui:browserPageSwipe', swipe)
  })
}
