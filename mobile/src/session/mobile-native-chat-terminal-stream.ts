export type MobileNativeChatTerminalStreamAction = 'pause' | 'resume' | 'none'

/** Decides whether the active mobile terminal stream should run while native chat
 *  covers its WebView. Resume is allowed only once the mounted WebView is ready. */
export function resolveMobileNativeChatTerminalStreamAction(args: {
  showNativeChat: boolean
  activeHandle: string | null
  activeTabType: string | null
  streamActive: boolean
  streamCovered: boolean
  webViewReady: boolean
}): MobileNativeChatTerminalStreamAction {
  if (!args.activeHandle || args.activeTabType !== 'terminal') {
    return 'none'
  }
  if (args.showNativeChat) {
    return !args.streamCovered ? 'pause' : 'none'
  }
  return (args.streamCovered || !args.streamActive) && args.webViewReady ? 'resume' : 'none'
}

export function isTerminalCoveredByNativeChat(
  showNativeChat: boolean,
  activeHandle: string | null,
  handle: string
): boolean {
  return showNativeChat && activeHandle === handle
}

export function mobileNativeChatTerminalCapabilities(covered: boolean): {
  terminalBinaryStream: 1
  mobileInputLeaseOnly?: 1
} {
  return covered
    ? { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 }
    : { terminalBinaryStream: 1 }
}
