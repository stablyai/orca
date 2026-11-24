import type { BrowserWindow } from 'electron'

/**
 * Lets the fixture window's pages produce frames on Linux without taking focus. Under Xvfb a
 * hidden window's guest stops producing frames once it is throttled, so paint waits time out and
 * pointer moves (dispatched on frames) never reach the page. The product only grabs from a shown
 * window; macOS and Windows keep painting hidden windows, so they stay hidden there.
 */
export function letFixtureWindowPaint(window: BrowserWindow): void {
  if (process.platform === 'linux') {
    window.showInactive()
  }
}
