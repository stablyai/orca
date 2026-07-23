export type MobileNativeChatTerminalStreamAction = 'pause' | 'resume' | 'none'

const MOBILE_NATIVE_CHAT_TERMINAL_RETRY_BASE_MS = 250
const MOBILE_NATIVE_CHAT_TERMINAL_RETRY_MAX_MS = 4_000

export function mobileNativeChatTerminalRetryDelay(attempt: number): number {
  return Math.min(
    MOBILE_NATIVE_CHAT_TERMINAL_RETRY_BASE_MS * 2 ** Math.max(0, attempt),
    MOBILE_NATIVE_CHAT_TERMINAL_RETRY_MAX_MS
  )
}

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

export function isMobileNativeChatLeaseReady(
  covered: boolean,
  event: Readonly<Record<string, unknown>>
): boolean {
  if (event.type !== 'subscribed') {
    return false
  }
  // Why: old hosts predate leaseReady but their lease-only subscribed event is
  // still authoritative; new hosts explicitly distinguish it from PTY timeout.
  return !covered || event.leaseReady === true || event.leaseReady === undefined
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

export function buildMobileNativeChatTerminalSubscribeParams(args: {
  terminal: string
  clientId: string
  covered: boolean
  viewport: { cols: number; rows: number } | null
}): {
  terminal: string
  client: { id: string; type: 'mobile' }
  viewport?: { cols: number; rows: number }
  capabilities: { terminalBinaryStream: 1; mobileInputLeaseOnly?: 1 }
} {
  // Why: chat needs only the input lease; awaiting a hidden terminal resize can
  // otherwise hold the acknowledgement behind SSH/provider latency.
  const viewport = mobileNativeChatSubscribeViewport(args.covered, args.viewport)
  return {
    terminal: args.terminal,
    client: { id: args.clientId, type: 'mobile' },
    ...(viewport ? { viewport } : {}),
    capabilities: mobileNativeChatTerminalCapabilities(args.covered)
  }
}
