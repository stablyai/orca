export type HostSessionBrowserTarget = {
  workspaceId: string
  pageId: string
}

export type HostSessionBrowserOperations = {
  back(target: HostSessionBrowserTarget): Promise<void>
  forward(target: HostSessionBrowserTarget): Promise<void>
  reload(target: HostSessionBrowserTarget): Promise<void>
}
