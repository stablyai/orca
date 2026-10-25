import { isStructuredAgentId } from '../../../src/shared/agent-session-provider-handle'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import { isRuntimeOwnedSshTargetId } from '../../../src/shared/execution-host'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from '../../../src/shared/native-chat-agent-support'

// Grok/omp lack hook transcript paths, so gate on serving-host readability when Model-A SSH keeps files remote.
export function isMobileNativeChatTranscriptReadable(
  connectionId: string | null | undefined
): boolean {
  return connectionId === null || isRuntimeOwnedSshTargetId(connectionId)
}

export type MobileNativeChatResolution = {
  agent: string
  sessionId: string | null
  // Forward the hook path because recent Claude sessions may not resolve by session id alone.
  transcriptPath: string | null
  // Remembered identity alone permits reads only; typing could otherwise reach a bare shell.
  agentConfirmed: boolean
}

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
  launchDraft?: string
  launchDraftCreatedAt?: number
  sessionId?: string | null
  agent?: string | null
}

export function resolveMobileNativeChat(
  tab: MobileNativeChatTab | null,
  nativeChatTranscriptIsLocalReadable = false
): MobileNativeChatResolution | null {
  if (!tab) {
    return null
  }
  if (tab.type === 'agent-session') {
    // Structured tabs use journals, so no per-agent transcript layout is needed.
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

// Missing status is not proof of pane change: retain identity until a new PTY handle replaces it, including pending/null handles.
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

export function isMobileNativeChatAgentConfirmed(tab: MobileNativeChatTab | null): boolean {
  return resolveMobileNativeChat(tab, true)?.agentConfirmed !== false
}

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
