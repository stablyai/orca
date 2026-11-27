// Push phone attention from the execution host so headless sessions need no desktop relay. Desktop retains presentation and marks local delivery to avoid duplicate pushes.
// Read labels synchronously at the raising commit so alerts cannot outlive prompts; edge ids dedupe delivery and address retirement.
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import {
  agentSessionAttentionKey,
  agentSessionAttentionNews,
  structuredAttentionOrigin,
  type StructuredAttentionState,
  type AgentSessionAttentionEdge
} from '../../../../shared/agent-session/view/agent-session-attention'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import { isCoordinatorOnlyChatNews } from '../../../../shared/orchestration/workers/dispatched-worker-attention'
import type {
  NotificationDispatchRequest,
  NotificationSettings
} from '../../../../shared/notifications/notification-settings-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { isNotificationSourceEnabled } from '../../../../shared/notifications/notification-source-gate'
import {
  folderWorkspaceKey,
  parseWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import { botGroupRoomPaneKey } from '../../../../shared/bots/bot-notification-pane-keys'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import {
  buildNotificationOptions,
  notificationNeedsSlackReplyCheck
} from '../../../ipc/notifications/notification-options'
import type { MobileNotificationDispatchEvent } from '../../push/notifications/runtime-mobile-notification-controller'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'
import type { Bot } from '../../../../shared/bot-types'
import { isBotAttentionSilenced } from '../../../../shared/bot-notifications'

export type StructuredAttentionWorkspaceLabels = { repoLabel?: string; worktreeLabel?: string }

export type BotGroupRoomOfSession = {
  group: Pick<BotGroup, 'id' | 'folderWorkspaceId'>
  threadId: string | undefined
}

export type StructuredAttentionMobileDeliveryDeps = {
  readNotificationSettings: () => NotificationSettings | undefined
  /** In-memory metadata only: a lookup that could wait would let the alert outlive its prompt. */
  readWorkspaceLabels: (scope: AgentSessionExecutionLocation) => StructuredAttentionWorkspaceLabels
  /** In-memory only, like the labels: the Filters hide it with "Notify About Hidden Workspaces" off, or its bot's switch is off. */
  isMuted: (
    scope: AgentSessionExecutionLocation,
    news: NonNullable<ReturnType<typeof agentSessionAttentionNews>>
  ) => boolean
  /** The dispatch context the session's chat row carries, by that row's pane key. */
  readOrchestration: (paneKey: string) => AgentStatusOrchestrationContext | undefined
  /** The group room a member session talks in; null for any other session. */
  readBotGroupRoom?: (sessionId: string) => BotGroupRoomOfSession | null
  /** Whether the session answers a Slack thread; its replies are written in Slack's markup. */
  repliesInSlack?: (sessionId: string) => boolean
  dispatch: (event: MobileNotificationDispatchEvent) => void
  /** Withdraws a notification this host delivered; a no-op for one it never sent. */
  reconcile: (state: StructuredAttentionState) => void
  now?: () => number
}

export type StructuredAttentionMobileDelivery = {
  deliver: (edge: AgentSessionAttentionEdge, summary: AgentSessionStatusSummary | undefined) => void
  reconcile: (state: StructuredAttentionState) => void
}

/** Read display labels from persisted host metadata without disk/Git lookups. */
export function readStructuredAttentionWorkspaceLabels(
  store: Pick<RuntimeStore, 'getRepo' | 'getWorktreeMeta' | 'getFolderWorkspaces'>,
  scope: AgentSessionExecutionLocation
): StructuredAttentionWorkspaceLabels {
  const folderScope = parseWorkspaceKey(scope.workspaceId)
  if (folderScope?.type === 'folder') {
    const folder = store
      .getFolderWorkspaces?.()
      .find((item) => item.id === folderScope.folderWorkspaceId)
    return folder ? { worktreeLabel: folder.name } : {}
  }
  const repo = store.getRepo(getRepoIdFromWorktreeId(scope.workspaceId))
  const worktreeLabel = store.getWorktreeMeta(scope.workspaceId)?.displayName
  return {
    ...(repo?.displayName ? { repoLabel: repo.displayName } : {}),
    ...(worktreeLabel ? { worktreeLabel } : {})
  }
}

/** Muted when the Filters hide its workspace with "Notify About Hidden Workspaces" off, or when its
 *  bot's switch for that news is off (a bot run that couldn't finish is a failed turn in the bot's home). */
export function isStructuredAttentionMuted(
  deps: {
    isWorkspaceMuted: (workspaceId: string) => boolean
    bots: () => readonly Pick<Bot, 'folderWorkspaceId' | 'notifications'>[]
  },
  scope: AgentSessionExecutionLocation,
  news: NonNullable<ReturnType<typeof agentSessionAttentionNews>>
): boolean {
  return (
    deps.isWorkspaceMuted(scope.workspaceId) ||
    isBotAttentionSilenced(deps.bots(), scope.workspaceId, news)
  )
}

function readLabels(
  deps: StructuredAttentionMobileDeliveryDeps,
  scope: AgentSessionExecutionLocation
): StructuredAttentionWorkspaceLabels {
  try {
    return deps.readWorkspaceLabels(scope)
  } catch {
    // A label is presentation: without one the alert still goes out, worded generically.
    return {}
  }
}

// A member runs in its bot's home but is answered in its room, so a tap opens the room.
// Phones have no thread rooms yet: a thread member's tap keeps opening its own chat.
function tapDestination(
  deps: StructuredAttentionMobileDeliveryDeps,
  scope: AgentSessionExecutionLocation,
  sessionId: string,
  paneKey: string
): { worktreeId: string; paneKey: string } {
  let room: BotGroupRoomOfSession | null = null
  try {
    room = deps.readBotGroupRoom?.(sessionId) ?? null
  } catch {
    // Navigation only: an unreadable room still alerts, opening the member's chat.
  }
  return room && !room.threadId
    ? {
        worktreeId: folderWorkspaceKey(room.group.folderWorkspaceId),
        paneKey: botGroupRoomPaneKey(room.group.id)
      }
    : { worktreeId: scope.workspaceId, paneKey }
}

export function createStructuredAttentionMobileDelivery(
  deps: StructuredAttentionMobileDeliveryDeps
): StructuredAttentionMobileDelivery {
  return {
    deliver: (edge, summary) => {
      const news = agentSessionAttentionNews(edge)
      if (!news) {
        return
      }
      const { scope, sessionId } = edge.type === 'prompt' ? edge.prompt : edge.completion
      // The host has no window tab id; the phone matches this session-derived key to the chat.
      const paneKey = structuredAgentSessionPaneKey(
        structuredAgentSessionTabId(sessionId),
        sessionId
      )
      if (
        deps.isMuted(scope, news) ||
        isCoordinatorOnlyChatNews(edge, news.agentState, () => deps.readOrchestration(paneKey))
      ) {
        return
      }
      const settings = deps.readNotificationSettings()!
      const attentionKey = agentSessionAttentionKey(edge)
      const request: NotificationDispatchRequest = {
        source: 'agent-task-complete',
        surface: 'agent-session',
        worktreeId: scope.workspaceId,
        ...readLabels(deps, scope),
        agentState: news.agentState,
        ...(news.outcome ? { agentTurnOutcome: news.outcome } : {}),
        ...(edge.type === 'completion' && edge.completion.failure
          ? { agentFailure: edge.completion.failure }
          : {}),
        ...(summary ? { agentType: summary.agent } : {}),
        ...(summary?.latestPrompt ? { agentPrompt: summary.latestPrompt } : {}),
        ...(summary?.lastAssistantMessage
          ? { agentLastAssistantMessage: summary.lastAssistantMessage }
          : {})
      }
      const { title, body } = buildNotificationOptions(
        notificationNeedsSlackReplyCheck(request) && deps.repliesInSlack?.(sessionId)
          ? { ...request, agentRepliesInSlack: true }
          : request,
        getRuntimeDesktopSurface().translateNotification
      )
      // Apply the desktop fan-out preferences to phone delivery too.
      const desktopAllowed = isNotificationSourceEnabled(
        settings,
        'agent-task-complete',
        news.agentState
      )
      deps.dispatch({
        type: 'notification',
        emittedAt: (deps.now ?? Date.now)(),
        source: 'agent-task-complete',
        ...(!desktopAllowed ? { desktopAllowed: false } : {}),
        title,
        body,
        ...tapDestination(deps, scope, sessionId, paneKey),
        notificationId: attentionKey,
        attentionKey,
        ...(structuredAttentionOrigin(edge)
          ? { structuredOrigin: structuredAttentionOrigin(edge) }
          : {}),
        agentState: news.agentState
      })
    },
    reconcile: deps.reconcile
  }
}
