// Scope composer drafts/chips by host, workspace and tab so switching cannot leak input into another terminal.
export function mobileNativeChatScopeKey(
  hostId: string,
  worktreeId: string,
  tabId: string | null
): string | null {
  return tabId ? `${hostId}\0${worktreeId}\0${tabId}` : null
}
