// Native screens have no shell frame to load; only the page asks its shell.
export function useMobileNativeChatVisualFrameGrant(): boolean {
  return false
}
