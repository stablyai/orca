import type { HostSessionNativeChatTarget } from './host-session-native-chat-operations'

/** Addresses one native-chat operation. Each operation reads only the coordinates
 *  it needs — a workspace-wide file search carries no transcript, a stop carries no
 *  session — so callers name what their call actually addresses and the rest stays
 *  empty rather than being invented. */
export function mobileNativeChatOperationTarget(
  args: Partial<HostSessionNativeChatTarget> & { workspaceId: string }
): HostSessionNativeChatTarget {
  return {
    workspaceId: args.workspaceId,
    agent: args.agent ?? '',
    sessionId: args.sessionId ?? '',
    transcriptPath: args.transcriptPath ?? null,
    terminalId: args.terminalId ?? null,
    clientId: args.clientId ?? null
  }
}
