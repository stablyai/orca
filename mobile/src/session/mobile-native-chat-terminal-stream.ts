export type MobileNativeChatTerminalStreamAction = 'pause' | 'resume' | 'rearm' | 'none'

export function resolveMobileNativeChatTerminalStreamAction(args: {
  showNativeChat: boolean
  activeHandle: string | null
  activeTabType: string | null
  streamActive: boolean
  streamCovered: boolean
  // Lease-only streams hold the input floor without delivering scrollback/data.
  streamIsLeaseOnly: boolean
  webViewReady: boolean
}): MobileNativeChatTerminalStreamAction {
  if (!args.activeHandle || args.activeTabType !== 'terminal') {
    return 'none'
  }
  if (args.showNativeChat) {
    if (!args.streamCovered) {
      return 'pause'
    }
    // Rearm missing covered streams or the composer loses its input lease indefinitely.
    return args.streamActive ? 'none' : 'rearm'
  }
  // Tab switching can open a lease before uncovering the terminal; resume output once its WebView is ready.
  return (args.streamCovered || args.streamIsLeaseOnly || !args.streamActive) && args.webViewReady
    ? 'resume'
    : 'none'
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

// Omit phone dims from input-only leases so native chat cannot resize the desktop PTY.
export function mobileNativeChatSubscribeViewport(
  covered: boolean,
  viewport: { cols: number; rows: number } | null
): { cols: number; rows: number } | undefined {
  return covered ? undefined : (viewport ?? undefined)
}
