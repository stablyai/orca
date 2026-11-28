// What a workspace teammate's client-events stream carries: one decision per event type, in a table
// whose type needs every event type, so a new one can't reach a teammate without a decision. Events
// about one workspace pass when it is the agent's (before or after the latest re-read of the set, so
// a removal still reaches them); the host's own (settings, SSH, Relay, navigation...) never do.
import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import {
  agentHasWorkspace,
  type AgentWorkspaceSet
} from '../../runtime/workspaces/process-listing/agent-workspace-set'
import type { BotChangeKind } from '../../../shared/bots/bot-change-scope'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  isPersonWorkspaceKey,
  parsePersonWorkspaceKey
} from '../../../shared/workspace/identity/person-workspace-key'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'

export const chatWorkspaceOf = (sessionId: string): string | undefined =>
  getStructuredAgentSessionHost()?.deps?.store.getConversation(sessionId)?.location.workspaceId

/** The set as of this event, and as it was before the read this event caused; the teammate. */
export type TeammateEventSets = {
  now: AgentWorkspaceSet
  before: AgentWorkspaceSet
  botId: string
  accountId: string
}

type EventOf<T extends RuntimeClientEvent['type']> = Extract<RuntimeClientEvent, { type: T }>
type Decision<T extends RuntimeClientEvent['type']> =
  | 'pass'
  | 'drop'
  | ((event: EventOf<T>, sets: TeammateEventSets) => RuntimeClientEvent | null)

const hasEither = ({ now, before }: TeammateEventSets, id: string | null | undefined) =>
  agentHasWorkspace(now, id) || agentHasWorkspace(before, id)
const repoEither = ({ now, before }: TeammateEventSets, repoId: string) =>
  now.repoIds.has(repoId) || before.repoIds.has(repoId)
const byWorkspace =
  <T extends RuntimeClientEvent['type']>(
    workspaceOf: (event: EventOf<T>) => string | null | undefined
  ): Decision<T> =>
  (event, sets) =>
    hasEither(sets, workspaceOf(event)) ? event : null

export const TEAMMATE_CLIENT_EVENT_DECISIONS: { [T in RuntimeClientEvent['type']]: Decision<T> } = {
  // Re-read triggers whose answers are themselves scoped, and the chat options the agent's chats follow.
  reposChanged: 'pass',
  agentListChanged: 'pass',
  worktreeRowsChanged: 'pass',
  agentOrchestrationChanged: 'pass',
  nativeChatQueueFollowUpsChanged: 'pass',
  nativeChatCiResultLinesChanged: 'pass',
  // An order save names every worktree in the repo; the owner's are not theirs to see.
  worktreesChanged: (event, sets) =>
    repoEither(sets, event.repoId)
      ? {
          ...event,
          ...(event.sortOrders
            ? { sortOrders: event.sortOrders.filter((row) => hasEither(sets, row.worktreeId)) }
            : {})
        }
      : null,
  gitStatusChanged: (event, sets) => {
    if (!repoEither(sets, event.repoId)) {
      return null
    }
    const worktreeIds = event.worktreeIds?.filter((id) => hasEither(sets, id))
    return worktreeIds?.length === 0 ? null : { ...event, ...(worktreeIds ? { worktreeIds } : {}) }
  },
  pullRequestChanged: byWorkspace((event) => event.worktreeId),
  // A teammate's own list's sleep reaches them alone, naming the Home they address.
  worktreeTerminalSleepState: (event, sets) => {
    const own = ownWorkspaceEvent(event, sets)
    return own && hasEither(sets, own.worktreeId) ? own : null
  },
  linearLinkedIssueUpdated: byWorkspace((event) => event.worktreeId),
  workspaceMetadataSet: byWorkspace((event) => event.worktreeId),
  terminalSideEffects: byWorkspace((event) => event.batch.worktreeId),
  orchestrationSessionWorkersChanged: byWorkspace((event) => chatWorkspaceOf(event.sessionId)),
  botsChanged: (event, { botId }) => botsChangedFor(event, botId),
  // The host's own: its navigation, settings, SSH, Relay, automations, CLI updates, MCP servers,
  // browser profiles, cleanup runs, peer mail, sidebar feed, notifications and chat drafts.
  activateWorktree: 'drop',
  sshStateChanged: 'drop',
  relayHostsChanged: 'drop',
  relayHostRowsChanged: 'drop',
  settingsChanged: 'drop',
  workspaceViewChanged: 'drop',
  automationsChanged: 'drop',
  agentCliUpdateFinished: 'drop',
  mcpServersChanged: 'drop',
  browserProfilesChanged: 'drop',
  workspaceCleanupRunFinished: 'drop',
  peerMailReturned: 'drop',
  sidebarInputsChanged: 'drop',
  notificationAttentionAcknowledged: 'drop',
  nativeChatLaunchDraftResolved: 'drop'
}

type AnyDecision =
  | 'pass'
  | 'drop'
  | ((event: RuntimeClientEvent, sets: TeammateEventSets) => RuntimeClientEvent | null)

export function teammateClientEvent(
  event: RuntimeClientEvent,
  sets: TeammateEventSets
): RuntimeClientEvent | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the table's entry for this event's type takes this event's type.
  const decision = TEAMMATE_CLIENT_EVENT_DECISIONS[event.type] as AnyDecision
  return decision === 'pass' ? event : decision === 'drop' ? null : decision(event, sets)
}

/** A bots notice for the shared bot alone: other bots' ids, kinds and items never reach a teammate.
 *  A kind `kindBots` names for other bots only is not about this one. Its Needs you counts are the
 *  owner's, so they are dropped and the teammate re-reads their own from bots.list. */
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
  const items = event.itemUids?.[botId]
  const { kindBots: _others, needsYou: _owners, ...rest } = event
  return {
    ...rest,
    botIds: [botId],
    ...(kinds ? { kinds } : {}),
    ...(event.itemUids ? { itemUids: items ? { [botId]: items } : {} } : {})
  }
}

/** An event about a teammate's own workspace (`person:`) as they address it, the Home; null for
 *  another person's. Any other event is as it is. */
function ownWorkspaceEvent<E extends { worktreeId: string }>(
  event: E,
  teammate: { botId: string; accountId: string }
): E | null {
  const person = parsePersonWorkspaceKey(event.worktreeId)
  if (!person) {
    return event
  }
  return person.botId === teammate.botId && person.accountId === teammate.accountId
    ? { ...event, worktreeId: folderWorkspaceKey(person.folderWorkspaceId) }
    : null
}

/** An event for a client that is no workspace's teammate (the owner's devices, the CLI): a
 *  teammate's own workspace is never theirs to hear of. */
export function hostClientEvent(event: RuntimeClientEvent): RuntimeClientEvent | null {
  return event.type === 'worktreeTerminalSleepState' && isPersonWorkspaceKey(event.worktreeId)
    ? null
    : event
}
