import { BaseWindow, WebContentsView, screen } from 'electron'
import type { WebContents, WebPreferences } from 'electron'

/**
 * The native side of an offscreen page: a WebContentsView in a hidden BaseWindow. The view gives
 * Chromium a size to lay out at; it is never shown. Why not a BrowserWindow: every BrowserWindow
 * is "an Orca window" to app code (window lists, broadcasts, IPC trust by getType()), and a page
 * must not be one. An offscreen view's WebContents reports getType() === 'offscreen'.
 */
export type OffscreenPageSurface = {
  readonly contents: WebContents
  /** Physical pixels per DIP the page paints at; fixed for the page's life. */
  readonly scaleFactor: number
  /** The page's layout viewport, in DIPs. */
  size(): { width: number; height: number }
  /** Resizes the page's layout viewport, in DIPs. */
  setSize(width: number, height: number): void
  isDestroyed(): boolean
  destroy(): void
}

export function createOffscreenPageSurface(args: {
  width: number
  height: number
  webPreferences: WebPreferences
}): OffscreenPageSurface {
  const window = new BaseWindow({ show: false, width: args.width, height: args.height })
  // Why the widest display: the factor is fixed at creation, and downscaling on a 1x display
  // stays sharp while upscaling on a Retina display would blur.
  const scaleFactor = Math.max(...screen.getAllDisplays().map((d) => d.scaleFactor), 1)
  const view = new WebContentsView({
    webPreferences: {
      ...args.webPreferences,
      offscreen: { useSharedTexture: true, deviceScaleFactor: scaleFactor }
    }
  })
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: args.width, height: args.height })
  const { webContents: contents } = view
  // Why: a key the page leaves unhandled goes to the app menu on macOS; a CDP key with no text
  // matches a menu item with no shortcut (About). User keys already met the menu in Orca's window.
  contents.setIgnoreMenuShortcuts(true)
  // Why: a view's WebContents outlives its window; whoever closes the window ends the page too.
  window.on('closed', () => {
    if (!contents.isDestroyed()) {
      contents.close()
    }
  })

  return {
    contents,
    scaleFactor,
    size() {
      const [width, height] = window.isDestroyed() ? [0, 0] : window.getContentSize()
      return { width, height }
    },
    setSize(width, height) {
      if (window.isDestroyed()) {
        return
      }
      // Why the window too: an offscreen view lays out at its window's content size.
      const [currentWidth, currentHeight] = window.getContentSize()
      if (currentWidth !== width || currentHeight !== height) {
        window.setContentSize(width, height)
        view.setBounds({ x: 0, y: 0, width, height })
      }
    },
    isDestroyed: () => window.isDestroyed() || contents.isDestroyed(),
    destroy() {
      if (!contents.isDestroyed()) {
        contents.close()
      }
      if (!window.isDestroyed()) {
        window.destroy()
      }
    }
  }
}
