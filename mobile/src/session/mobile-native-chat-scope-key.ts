/** Identity of a native-chat composer surface: host + worktree + tab. Drafts
 *  and pending image chips are both keyed by it, so a tab switch cannot leak
 *  one tab's composer state into another tab's terminal. */
export function mobileNativeChatScopeKey(
  hostId: string,
  worktreeId: string,
  tabId: string | null
): string | null {
  return tabId ? `${hostId}\0${worktreeId}\0${tabId}` : null
}
