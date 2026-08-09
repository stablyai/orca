import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import { isRuntimeOwnedSshTargetId, parseExecutionHostId } from '../../../src/shared/execution-host'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresHostReadableTranscript
} from '../../../src/shared/native-chat-agent-support'

// Why: native chat reads the serving host's transcript storage; Model-A SSH
// has no runtime reader, so all supported agents must be host-readable there.
export function isMobileNativeChatTranscriptReadable(
  connectionId: string | null | undefined
): boolean {
  return connectionId === null || isRuntimeOwnedSshTargetId(connectionId)
}

/** Resolve folder-workspace ownership from the host id returned by worktree.show. */
export function isMobileNativeChatHostReadable(hostId: string | null | undefined): boolean {
  const host = parseExecutionHostId(hostId)
  if (!host) {
    return false
  }
  return host.kind !== 'ssh' || isMobileNativeChatTranscriptReadable(host.targetId)
}

export type MobileNativeChatResolution = {
  agent: string
  /** The agent's own session id, or null before it has reported one (the view
   *  then shows a waiting state instead of trying to read an unaddressable file). */
  sessionId: string | null
  /** Hook-reported transcript path. Recent Claude sessions cannot always be
   *  resolved from the provider session id, so mobile forwards this to runtime. */
  transcriptPath: string | null
}

export type MobileNativeChatTab = {
  type: string
  launchAgent?: string | null
  agentStatus?: AgentStatusEntry | null
  /** Host-provided launch context still parked as an unsent TUI-input draft. */
  launchDraft?: string
  launchDraftCreatedAt?: number
}

/** Resolve a session tab to the transcript identity native chat needs, or
 *  null when the tab can't show native chat (not a terminal, no agent, or an
 *  agent whose transcript the host can't read). Agent comes from the launch
 *  hint or the live status; session id from the captured provider session. */
export function resolveMobileNativeChat(
  tab: MobileNativeChatTab | null,
  nativeChatTranscriptIsLocalReadable?: boolean
): MobileNativeChatResolution | null {
  if (!tab || tab.type !== 'terminal') {
    return null
  }
  const liveAgent = tab.agentStatus?.agentType ?? null
  const agent = liveAgent
    ? isNativeChatSupportedAgent(liveAgent)
      ? liveAgent
      : null
    : tab.launchAgent
  if (!agent || !isNativeChatSupportedAgent(agent)) {
    return null
  }
  if (
    nativeChatRequiresHostReadableTranscript(agent) &&
    nativeChatTranscriptIsLocalReadable === false
  ) {
    return null
  }
  return {
    agent,
    sessionId: tab.agentStatus?.providerSession?.id ?? null,
    transcriptPath: tab.agentStatus?.providerSession?.transcriptPath ?? null
  }
}

/** Whether the tab can toggle into native chat — gates the long-press item. */
export function canShowMobileNativeChat(
  tab: MobileNativeChatTab | null,
  nativeChatTranscriptIsLocalReadable?: boolean
): boolean {
  return resolveMobileNativeChat(tab, nativeChatTranscriptIsLocalReadable) !== null
}
