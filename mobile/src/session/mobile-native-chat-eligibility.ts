import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'

// Why: native chat renders an agent's own JSONL transcript, and the host
// resolver only knows Claude's and Codex's transcript layouts. So the mobile
// toggle is offered only for those agents — other agents (or a plain shell)
// have no readable transcript and would render an empty/error view.
const NATIVE_CHAT_SUPPORTED_AGENTS = new Set(['claude', 'codex'])

export type MobileNativeChatResolution = {
  agent: string
  /** The agent's own session id, or null before it has reported one (the view
   *  then shows a waiting state instead of trying to read an unaddressable file). */
  sessionId: string | null
  /** Authoritative transcript path from the hook (providerSession), preferred
   *  over reconstructing the path from sessionId (recent Claude Code diverges). */
  transcriptPath: string | null
}

type TerminalTabLike = {
  type: string
  launchAgent?: string | null
  agentStatus?: AgentStatusEntry | null
}

/** Resolve a session tab to the `{ agent, sessionId }` native chat needs, or
 *  null when the tab can't show native chat (not a terminal, no agent, or an
 *  agent whose transcript the host can't read). Agent comes from the launch
 *  hint or the live status; session id from the captured provider session. */
export function resolveMobileNativeChat(
  tab: TerminalTabLike | null
): MobileNativeChatResolution | null {
  if (!tab || tab.type !== 'terminal') {
    return null
  }
  const agent = tab.launchAgent ?? tab.agentStatus?.agentType ?? null
  if (!agent || !NATIVE_CHAT_SUPPORTED_AGENTS.has(agent)) {
    return null
  }
  return {
    agent,
    sessionId: tab.agentStatus?.providerSession?.id ?? null,
    transcriptPath: tab.agentStatus?.providerSession?.transcriptPath ?? null
  }
}

/** Whether the tab can toggle into native chat — gates the long-press item. */
export function canShowMobileNativeChat(tab: TerminalTabLike | null): boolean {
  return resolveMobileNativeChat(tab) !== null
}
