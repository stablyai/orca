import type { BrowserWindow } from 'electron'

/** Resolve once the window is visible, or false if it is destroyed first; never reveals it. */
export function waitForWindowToShow(parentWindow: BrowserWindow): Promise<boolean> {
  if (parentWindow.isDestroyed()) {
    return Promise.resolve(false)
  }
  const parentWebContents = parentWindow.webContents
  if (parentWebContents.isDestroyed()) {
    return Promise.resolve(false)
  }
  if (parentWindow.isVisible()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const settle = (visible: boolean): void => {
      parentWindow.removeListener('show', onShow)
      parentWebContents.removeListener('destroyed', onDestroyed)
      resolve(visible)
    }
    const onShow = (): void =>
      settle(!parentWindow.isDestroyed() && !parentWebContents.isDestroyed())
    const onDestroyed = (): void => settle(false)
    parentWindow.once('show', onShow)
    // Why: keep this failure-only waiter off the crowded BrowserWindow `closed` event.
    parentWebContents.once('destroyed', onDestroyed)
  })
}
