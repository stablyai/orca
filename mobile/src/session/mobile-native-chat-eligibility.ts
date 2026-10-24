import { isStructuredAgentId } from '../../../src/shared/agent-session-provider-handle'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import { isRuntimeOwnedSshTargetId } from '../../../src/shared/execution-host'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from '../../../src/shared/native-chat-agent-support'

// Why: native chat renders an agent's own JSONL transcript, and the host
// resolver knows these transcript layouts. Agents whose hook reports no
// transcript path (Grok, omp) are additionally gated on host readability,
// because Model-A SSH stores their transcript on the remote target.
export function isMobileNativeChatTranscriptReadable(
  connectionId: string | null | undefined
): boolean {
  return connectionId === null || isRuntimeOwnedSshTargetId(connectionId)
}

export type MobileNativeChatResolution = {
  agent: string
  /** The agent's own session id, or null before it has reported one (the view
   *  then shows a waiting state instead of trying to read an unaddressable file). */
  sessionId: string | null
  /** Hook-reported transcript path. Recent Claude sessions cannot always be
   *  resolved from the provider session id, so mobile forwards this to runtime. */
  transcriptPath: string | null
  /** False when only this phone's memory names the agent: it may have exited to a
   *  shell, so the chat is read-only rather than typing into a bare prompt. */
  agentConfirmed: boolean
}

/** The last chat identity resolved for a terminal tab, bound to the handle it was seen on. */
export type MobileNativeChatIdentity = {
  terminal: string
  agent: string
  sessionId: string | null
  transcriptPath: string | null
}

export type MobileNativeChatTab = {
  type: string
  launchAgent?: string | null
  agentStatus?: AgentStatusEntry | null
  nativeChatIdentity?: MobileNativeChatIdentity
  /** Host-provided launch context still parked as an unsent TUI-input draft. */
  launchDraft?: string
  launchDraftCreatedAt?: number
  sessionId?: string | null
  agent?: string | null
}

/** Resolve a session tab to the transcript identity native chat needs, or
 *  null when the tab can't show native chat (not a terminal, no agent, or an
 *  agent whose transcript the host can't read). Agent comes from the launch
 *  hint or the live status; session id from the captured provider session. */
export function resolveMobileNativeChat(
  tab: MobileNativeChatTab | null,
  nativeChatTranscriptIsLocalReadable = false
): MobileNativeChatResolution | null {
  if (!tab) {
    return null
  }
  if (tab.type === 'agent-session') {
    // Structured tabs are journal-backed, so any agent the host lists renders here — there is no
    // per-agent transcript layout to know.
    return tab.sessionId && isStructuredAgentId(tab.agent)
      ? { agent: tab.agent, sessionId: tab.sessionId, transcriptPath: null, agentConfirmed: true }
      : null
  }
  if (tab.type !== 'terminal') {
    return null
  }
  const liveAgent = tab.agentStatus?.agentType ?? null
  const remembered = tab.nativeChatIdentity ?? null
  const agent = liveAgent
    ? isNativeChatSupportedAgent(liveAgent)
      ? liveAgent
      : null
    : // The remembered agent is the latest resolution, so it outranks an older launch hint.
      (remembered?.agent ?? tab.launchAgent ?? null)
  if (!agent || !isNativeChatSupportedAgent(agent)) {
    return null
  }
  if (nativeChatRequiresLocalTranscript(agent) && !nativeChatTranscriptIsLocalReadable) {
    return null
  }
  const liveSession = tab.agentStatus?.providerSession
  // A live agent without a session may be a relaunch; only an identity-less frame inherits one.
  const rememberedSession = !liveAgent && remembered?.agent === agent ? remembered : null
  return {
    agent,
    sessionId: liveSession?.id ?? rememberedSession?.sessionId ?? null,
    transcriptPath: liveSession
      ? (liveSession.transcriptPath ?? null)
      : (rememberedSession?.transcriptPath ?? null),
    agentConfirmed: liveAgent ? true : tab.launchAgent === agent
  }
}

/** Why: a status frame that omits the agent or its session (an older host, a re-subscribe) is
 *  missing evidence, not proof the pane changed, so chat must not flip to the terminal. A new
 *  handle is a new PTY and starts fresh; a pending (null) handle keeps the last identity. */
// Why structural, not MobileSessionTab: the route types pull React Native globals into e2e.
export function withRememberedNativeChatIdentity<
  T extends MobileNativeChatTab & { id: string; terminal?: string | null }
>(tabs: T[], previous: readonly T[]): T[] {
  const previousById = new Map(previous.map((tab) => [tab.id, tab]))
  return tabs.map((tab) => {
    if (tab.type !== 'terminal') {
      return tab
    }
    const priorTab = previousById.get(tab.id)
    const prior = priorTab?.type === 'terminal' ? priorTab.nativeChatIdentity : undefined
    const carried =
      prior && (tab.terminal == null || tab.terminal === prior.terminal) ? prior : undefined
    const resolved = resolveMobileNativeChat({ ...tab, nativeChatIdentity: carried }, true)
    const terminal = tab.terminal ?? carried?.terminal
    const nativeChatIdentity =
      resolved && terminal
        ? {
            terminal,
            agent: resolved.agent,
            sessionId: resolved.sessionId,
            transcriptPath: resolved.transcriptPath
          }
        : undefined
    return { ...tab, nativeChatIdentity }
  })
}

/** False only when this phone's memory alone names the tab's chat agent; chat writes stay locked. */
export function isMobileNativeChatAgentConfirmed(tab: MobileNativeChatTab | null): boolean {
  return resolveMobileNativeChat(tab, true)?.agentConfirmed !== false
}

/** Whether the tab can toggle into native chat — gates the long-press item. */
export function canShowMobileNativeChat(
  tab: MobileNativeChatTab | null,
  nativeChatTranscriptIsLocalReadable = false
): boolean {
  return resolveMobileNativeChat(tab, nativeChatTranscriptIsLocalReadable) !== null
}

export function resolveMobileNativeChatSessionId(tab: MobileNativeChatTab | null): string | null {
  if (tab?.type === 'agent-session') {
    return tab.sessionId ?? null
  }
  if (tab?.type === 'terminal') {
    return (
      tab.agentStatus?.providerSession?.id ?? resolveMobileNativeChat(tab, true)?.sessionId ?? null
    )
  }
  return null
}

export function isMobileFolderNativeChatReadable(value: unknown, worktreeId: string): boolean {
  if (
    !value ||
    typeof value !== 'object' ||
    !('folderWorkspaces' in value) ||
    !Array.isArray(value.folderWorkspaces)
  ) {
    return false
  }
  const id = worktreeId.slice('folder:'.length)
  const workspace = value.folderWorkspaces.find(
    (row: unknown) => row !== null && typeof row === 'object' && 'id' in row && row.id === id
  )
  if (!workspace || typeof workspace !== 'object') {
    return false
  }
  const connectionId = 'connectionId' in workspace ? workspace.connectionId : null
  return (
    connectionId === null ||
    (typeof connectionId === 'string' && isMobileNativeChatTranscriptReadable(connectionId))
  )
}
