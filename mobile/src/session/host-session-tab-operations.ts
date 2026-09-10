export type HostSessionTabOperations = {
  createBrowser(workspaceId: string, url: string): Promise<{ browserPageId?: string }>
  /** True when the host accepted the request. The caller prunes on that alone, as it did
   *  before this seam existed; a refusal is undone by the host's republished snapshot. */
  close(workspaceId: string, tabId: string): Promise<boolean>
}
