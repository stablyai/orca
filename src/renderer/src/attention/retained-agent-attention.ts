import { notificationSourceForOwner } from '../../../shared/notifications/notification-source'
import { isWorkspaceNotificationMutedBySidebarFilters } from './hidden-workspace-notification-mute'
import type { RetainedAgentAttention } from '../../../shared/notifications/notification-settings-types'
import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host/execution-host'
import { notificationDeliveryId } from '../../../shared/notifications/notification-delivery-id'
import { makePaneKey, parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { useAppStore } from '../store'
import {
  deliverAgentAttentionNotification,
  readAgentAttentionNotificationSound
} from './agent-attention-notification-delivery'

type CatalogState = { runtimeEnvironments?: readonly { id: string }[] }

/** Retained host attention uses the same client policy and delivery as agent input requests. */
export function createRetainedAgentAttentionReceiver() {
  const presentedByEnvironment = new Map<string, Map<string, string>>()
  const receive = (
    environmentId: string,
    event: Extract<RuntimeClientEvent, { type: 'agentAttentionChanged' }>
  ): void => {
    const executionHost = toRuntimeExecutionHostId(environmentId)
    const id = notificationDeliveryId(event.notificationId, executionHost)
    const notice = event.notice
    const presented = presentedByEnvironment.get(environmentId)
    if (!notice) {
      presented?.delete(id)
      void window.api.notifications.dismiss([id])
      return
    }
    const content = { title: notice.title, body: notice.body }
    const signature = JSON.stringify(content)
    if (presented?.get(id) === signature) {
      return
    }
    if (presented) {
      presented.set(id, signature)
    } else {
      presentedByEnvironment.set(environmentId, new Map([[id, signature]]))
    }
    const state = useAppStore.getState()
    if (
      notice.worktreeId &&
      isWorkspaceNotificationMutedBySidebarFilters(state, notice.worktreeId)
    ) {
      return
    }
    const pane = notice.paneKey ? parsePaneKey(notice.paneKey) : null
    deliverAgentAttentionNotification(
      {
        source: 'agent-task-complete',
        agentState: 'waiting',
        content,
        notificationId: notice.notificationId,
        attentionKey: JSON.stringify([id, content]),
        executionHost,
        worktreeId: notice.worktreeId,
        workspaceExecutionHostId: null,
        notificationSourceId: notificationSourceForOwner(
          { executionHostId: executionHost, runtimeEnvironmentId: environmentId },
          state
        ),
        paneKey: pane ? makePaneKey(toWebTerminalSurfaceTabId(pane.tabId), pane.leafId) : undefined,
        isActiveWorktree:
          state.activeWorktreeId === notice.worktreeId &&
          state.activeWorkspaceExecutionHostId === executionHost,
        mobileDeliveredByHost: true
      },
      readAgentAttentionNotificationSound(state.settings ?? {})
    )
  }
  return {
    receive,
    reconcile: (environmentId: string, notices: RetainedAgentAttention[]): void => {
      const host = toRuntimeExecutionHostId(environmentId)
      const retained = new Set(
        notices.map((notice) => notificationDeliveryId(notice.notificationId, host))
      )
      const presented = presentedByEnvironment.get(environmentId)
      for (const id of presented?.keys() ?? []) {
        if (!retained.has(id)) {
          presented?.delete(id)
          void window.api.notifications.dismiss([id])
        }
      }
      for (const notice of notices) {
        receive(environmentId, {
          type: 'agentAttentionChanged',
          notificationId: notice.notificationId,
          notice
        })
      }
    },
    /** A host removed from the catalog sends no clearing snapshot, so its notice state ends here. */
    keepCatalogEnvironments: (state: CatalogState, previous?: CatalogState): void => {
      if (previous && previous.runtimeEnvironments === state.runtimeEnvironments) {
        return
      }
      // Why the catalog, not connection: a disconnected host keeps its notices for the reconnect snapshot.
      for (const environmentId of presentedByEnvironment.keys()) {
        if (!state.runtimeEnvironments?.some((environment) => environment.id === environmentId)) {
          presentedByEnvironment.delete(environmentId)
        }
      }
    },
    presentedNoticeCount: (): number => {
      let count = 0
      for (const presented of presentedByEnvironment.values()) {
        count += presented.size
      }
      return count
    }
  }
}
