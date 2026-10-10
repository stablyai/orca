// The execution host's own delivery of structured-chat attention to the phones paired with it.
//
// WHY THE HOST: a structured session runs here and its attention edges are derived here, so a phone
// paired to this host (a headless `orca serve` or `orcad` included) must not depend on some desktop
// keeping a chat tab open to relay them. Desktops keep presentation only: unread, focus suppression
// and their own OS banner. A local desktop marks its request so main does not push the phone twice.
//
// SENT AT THE COMMIT THAT RAISED IT: labels come from metadata already in memory, never a disk or
// Git lookup, so the alert can't arrive after the prompt was answered. Each notification is keyed by
// the edge's identity, which delivery dedupes on and retirement addresses.
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  agentSessionAttentionKey,
  agentSessionAttentionNews,
  structuredAttentionOrigin,
  type StructuredAttentionState,
  type AgentSessionAttentionEdge
} from '../../shared/agent-session-attention'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type {
  NotificationDispatchRequest,
  NotificationSettings
} from '../../shared/notification-settings-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { buildNotificationOptions } from '../ipc/notification-options'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'
import type { RuntimeStore } from './runtime-store-contract'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'

export type StructuredAttentionWorkspaceLabels = { repoLabel?: string; worktreeLabel?: string }

export type StructuredAttentionMobileDeliveryDeps = {
  readNotificationSettings: () => NotificationSettings
  /** In-memory metadata only: a lookup that could wait would let the alert outlive its prompt. */
  readWorkspaceLabels: (scope: AgentSessionExecutionLocation) => StructuredAttentionWorkspaceLabels
  dispatch: (event: MobileNotificationDispatchEvent) => void
  /** Withdraws a notification this host delivered; a no-op for one it never sent. */
  reconcile: (state: StructuredAttentionState) => void
  now: () => number
}

export type StructuredAttentionMobileDelivery = {
  deliver: (edge: AgentSessionAttentionEdge, summary: AgentSessionStatusSummary | undefined) => void
  reconcile: (state: StructuredAttentionState) => void
}

/** The labels the desktop shows for a workspace, from the host's persisted metadata alone. */
export function readStructuredAttentionWorkspaceLabels(
  store: Pick<RuntimeStore, 'getRepo' | 'getWorktreeMeta' | 'getFolderWorkspaces'>,
  scope: AgentSessionExecutionLocation
): StructuredAttentionWorkspaceLabels {
  if (scope.workspaceKind === 'folder') {
    const folder = store.getFolderWorkspaces?.().find((item) => item.id === scope.workspaceId)
    return folder ? { worktreeLabel: folder.name } : {}
  }
  const repo = store.getRepo(getRepoIdFromWorktreeId(scope.workspaceId))
  const worktreeLabel = store.getWorktreeMeta(scope.workspaceId)?.displayName
  return {
    ...(repo?.displayName ? { repoLabel: repo.displayName } : {}),
    ...(worktreeLabel ? { worktreeLabel } : {})
  }
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

export function createStructuredAttentionMobileDelivery(
  deps: StructuredAttentionMobileDeliveryDeps
): StructuredAttentionMobileDelivery {
  return {
    deliver: (edge, summary) => {
      const news = agentSessionAttentionNews(edge)
      if (!news) {
        return
      }
      const scope = edge.type === 'prompt' ? edge.prompt.scope : edge.completion.scope
      const attentionKey = agentSessionAttentionKey(edge)
      const request: NotificationDispatchRequest = {
        source: 'agent-task-complete',
        surface: 'agent-session',
        worktreeId: scope.workspaceId,
        ...readLabels(deps, scope),
        agentState: news.agentState,
        ...(news.outcome ? { agentTurnOutcome: news.outcome } : {}),
        ...(summary ? { agentType: summary.agent } : {}),
        ...(summary?.latestPrompt ? { agentPrompt: summary.latestPrompt } : {}),
        ...(summary?.lastAssistantMessage
          ? { agentLastAssistantMessage: summary.lastAssistantMessage }
          : {})
      }
      const { title, body } = buildNotificationOptions(
        request,
        getRuntimeDesktopSurface().translateNotification
      )
      const settings = deps.readNotificationSettings()
      // The same eligibility the desktop's own fan-out applies: these preferences gate the phone too.
      const desktopAllowed = settings.enabled && settings.agentTaskComplete
      deps.dispatch({
        type: 'notification',
        emittedAt: deps.now(),
        source: 'agent-task-complete',
        ...(!desktopAllowed ? { desktopAllowed: false } : {}),
        title,
        body,
        worktreeId: scope.workspaceId,
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
