import type { WebContents } from 'electron'

// Windows that load the Orca renderer preload (main window, dashboard popout).
// Only these can answer preload-driven handshakes such as the pre-relaunch
// preparation round; offscreen browser-backend, html-to-pdf, and cookie-clear
// windows never load it and must not be handshake targets.
// Why no destroy cleanup: WebContents ids are process-unique and never reused,
// and callers intersect with live BrowserWindow lists anyway.
const rendererPreloadWebContentsIds = new Set<number>()

export function registerRendererPreloadWindow(contents: WebContents): void {
  rendererPreloadWebContentsIds.add(contents.id)
}

export function isRendererPreloadWindow(contents: WebContents): boolean {
  return rendererPreloadWebContentsIds.has(contents.id)
}
