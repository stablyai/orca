export type MobileNativeChatTerminalStreamAction = 'pause' | 'resume' | 'rearm' | 'none'

/** Decides whether the active mobile terminal stream should run while native chat
 *  covers its WebView. Resume is allowed only once the mounted WebView is ready. */
export function resolveMobileNativeChatTerminalStreamAction(args: {
  showNativeChat: boolean
  activeHandle: string | null
  activeTabType: string | null
  streamActive: boolean
  streamCovered: boolean
  /** The active stream was opened as an input lease, so the host sends `subscribed`
   *  and nothing else — no scrollback, no data. Distinguishes a stream that renders
   *  from one that only holds the input floor. */
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
    // Why: the covered stream IS the input lease. Anything that tore it down
    // (terminal.list churn, a client swap, an `end` frame) would otherwise leave
    // the composer locked forever — nothing else re-subscribes a covered handle.
    return args.streamActive ? 'none' : 'rearm'
  }
  // Why `streamIsLeaseOnly`: switching from a chat tab to a terminal tab subscribes the
  // incoming handle before the route learns chat is gone, so it lands a lease-only stream
  // on an uncovered handle. Without this input that is indistinguishable from a healthy
  // stream and the terminal renders blank until restart.
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

// Why: a covered subscribe is only an input lease — carrying phone dims would make the host phone-fit a PTY native chat never renders.
export function mobileNativeChatSubscribeViewport(
  covered: boolean,
  viewport: { cols: number; rows: number } | null
): { cols: number; rows: number } | undefined {
  return covered ? undefined : (viewport ?? undefined)
}
