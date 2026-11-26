// What a workspace teammate's client-events stream carries: each event type decided once, here. Events
// about one workspace pass when it is the agent's; the host's own (its settings, SSH, Relay, accounts,
// navigation) never do. The switch is exhaustive, so a new event type needs a decision to build.
import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import {
  agentHasWorkspace,
  type AgentWorkspaceSet
} from '../../runtime/workspaces/process-listing/agent-workspace-set'
import type { BotChangeKind } from '../../../shared/bots/bot-change-scope'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'

type SessionWorkspaceLookup = (sessionId: string) => string | undefined

const chatWorkspaceOf: SessionWorkspaceLookup = (sessionId) =>
  getStructuredAgentSessionHost()?.deps?.store.getConversation(sessionId)?.location.workspaceId

export function teammateClientEvent(
  event: RuntimeClientEvent,
  set: AgentWorkspaceSet,
  scope: Pick<BotShareCallerScope, 'botId'>,
  workspaceOfChat: SessionWorkspaceLookup = chatWorkspaceOf
): RuntimeClientEvent | null {
  const has = (id: string | null | undefined) => agentHasWorkspace(set, id)
  switch (event.type) {
    // Re-read triggers whose answers are themselves scoped, and the chat options the agent's chats follow.
    case 'reposChanged':
    case 'agentListChanged':
    case 'worktreeRowsChanged':
    case 'agentOrchestrationChanged':
    case 'nativeChatQueueFollowUpsChanged':
    case 'nativeChatCiResultLinesChanged':
      return event
    case 'worktreesChanged':
      return set.repoIds.has(event.repoId) ? event : null
    case 'gitStatusChanged': {
      if (!set.repoIds.has(event.repoId)) {
        return null
      }
      if (!event.worktreeIds) {
        return event
      }
      const worktreeIds = event.worktreeIds.filter(has)
      return worktreeIds.length > 0 ? { ...event, worktreeIds } : null
    }
    case 'pullRequestChanged':
    case 'worktreeTerminalSleepState':
    case 'linearLinkedIssueUpdated':
    case 'workspaceMetadataSet':
      return has(event.worktreeId) ? event : null
    case 'terminalSideEffects':
      return has(event.batch.worktreeId) ? event : null
    case 'orchestrationSessionWorkersChanged':
      return has(workspaceOfChat(event.sessionId)) ? event : null
    case 'botsChanged':
      return botsChangedFor(event, scope.botId)
    // The host's own: its navigation, settings, SSH, Relay, automations, CLI updates, MCP servers,
    // browser profiles, cleanup runs, peer mail, sidebar feed, notifications and chat drafts.
    case 'activateWorktree':
    case 'sshStateChanged':
    case 'relayHostsChanged':
    case 'settingsChanged':
    case 'workspaceViewChanged':
    case 'automationsChanged':
    case 'agentCliUpdateFinished':
    case 'mcpServersChanged':
    case 'browserProfilesChanged':
    case 'workspaceCleanupRunFinished':
    case 'peerMailReturned':
    case 'sidebarInputsChanged':
    case 'notificationAttentionAcknowledged':
    case 'nativeChatLaunchDraftResolved':
      return null
  }
}

/** A bots notice for the shared bot alone: other bots' ids, kinds, items and counts never reach a
 *  teammate. A kind `kindBots` names for other bots only is not about this one. */
function botsChangedFor(
  event: Extract<RuntimeClientEvent, { type: 'botsChanged' }>,
  botId: string
): RuntimeClientEvent | null {
  if (event.botIds && !event.botIds.includes(botId)) {
    return null
  }
  const about = (kind: BotChangeKind) => event.kindBots?.[kind]?.includes(botId) ?? true
  const kinds = event.kinds?.filter(about)
  if (kinds?.length === 0) {
    return null
  }
  const count = event.needsYou?.counts[botId]
  const items = event.itemUids?.[botId]
  const { kindBots: _others, ...rest } = event
  return {
    ...rest,
    botIds: [botId],
    ...(kinds ? { kinds } : {}),
    ...(event.needsYou
      ? { needsYou: { ...event.needsYou, counts: count === undefined ? {} : { [botId]: count } } }
      : {}),
    ...(event.itemUids ? { itemUids: items ? { [botId]: items } : {} } : {})
  }
}
