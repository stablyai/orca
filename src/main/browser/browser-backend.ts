// Why: browser pages can be backed two ways. A desktop renderer mounts an
// Electron <webview> (renderer backend). A headless orca serve has no renderer
// window, so it backs pages with main-process offscreen WebContents (offscreen
// backend). Both register the page's WebContents into BrowserManager, so every
// downstream command (agent-browser automation, screencast, input) resolves a
// WebContents uniformly regardless of how the page was created. This interface
// isolates the only step that actually differs: tab creation and teardown.

export type BrowserBackendCreateTab = {
  url: string
  worktreeId?: string
  profileId?: string
}

export type BrowserBackend = {
  /** Create a browser page and register its WebContents. Returns the page id. */
  createTab(params: BrowserBackendCreateTab): Promise<{ browserPageId: string }>
  /** Tear down a browser page created by this backend. */
  closeTab(browserPageId: string): Promise<void>
  /** Tear down every page this backend owns (process shutdown). Optional —
   *  renderer-hosted backends are torn down with their window. */
  destroyAll?(): void
}
