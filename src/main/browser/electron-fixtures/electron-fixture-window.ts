import type { BrowserWindow } from 'electron'
import { ELECTRON_FIXTURE_PRIVATE_DISPLAY_ENV } from './electron-fixture-result'

/**
 * Lets the fixture window's pages produce frames on Linux without taking focus. Under Xvfb a
 * hidden window's guest stops producing frames once it is throttled, so paint waits time out and
 * pointer moves (dispatched on frames) never reach the page. The product only grabs from a shown
 * window; macOS and Windows keep painting hidden windows, so they stay hidden there. Shown only on
 * the private display the fixture runner made, never on a desktop the user is looking at.
 */
export function letFixtureWindowPaint(window: BrowserWindow): void {
  if (process.platform === 'linux' && process.env[ELECTRON_FIXTURE_PRIVATE_DISPLAY_ENV] === '1') {
    window.showInactive()
  }
}
