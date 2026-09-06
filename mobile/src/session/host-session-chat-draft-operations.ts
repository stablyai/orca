export type HostSessionChatDraftOperations = {
  load: (workspaceId: string, tabId: string) => Promise<string>
  save: (workspaceId: string, tabId: string, text: string) => Promise<void>
}
