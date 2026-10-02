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
  // Why frameless: in a titled window an offscreen view lays the page out 32px (the title bar)
  // taller than its bounds, so the frame drawn into the pane came out squashed.
  const window = new BaseWindow({
    show: false,
    frame: false,
    width: args.width,
    height: args.height
  })
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
      if (window.isDestroyed()) {
        return { width: 0, height: 0 }
      }
      const { width, height } = view.getBounds()
      return { width, height }
    },
    setSize(width, height) {
      if (window.isDestroyed()) {
        return
      }
      const current = view.getBounds()
      if (current.width !== width || current.height !== height) {
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
