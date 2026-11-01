// Renderer webviews and headless offscreen pages share BrowserManager; creation and teardown differ.

export type BrowserBackendCreateTab = {
  url: string
  worktreeId?: string
  profileId?: string
  browserPageId?: string
}

export type BrowserBackend = {
  /** Create a browser page and register its WebContents. Returns the page id. */
  createTab(params: BrowserBackendCreateTab): Promise<{ browserPageId: string }>
  closeTab(browserPageId: string): Promise<void>
  /** True only for pages this backend created; the bridge also lists an attached window's webviews. */
  ownsTab(browserPageId: string): boolean
  /** Renderer backends may omit shutdown cleanup because their window owns the pages. */
  destroyAll?(): void | Promise<void>
}
