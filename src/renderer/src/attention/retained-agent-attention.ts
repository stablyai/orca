import { notificationSourceForOwner } from '../../../shared/notification-source'
import { isWorkspaceNotificationMutedBySidebarFilters } from './hidden-workspace-notification-mute'
import type { RetainedAgentAttention } from '../../../shared/notification-settings-types'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { notificationDeliveryId } from '../../../shared/notification-delivery-id'
import { makePaneKey, parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { useAppStore } from '../store'
import {
  deliverAgentAttentionNotification,
  readAgentAttentionNotificationSound
} from './agent-attention-notification-delivery'

/** Retained host attention uses the same client policy and delivery as agent input requests. */
export function createRetainedAgentAttentionReceiver() {
  const presented = new Map<string, { environmentId: string; signature: string }>()
  const receive = (
    environmentId: string,
    event: Extract<RuntimeClientEvent, { type: 'agentAttentionChanged' }>
  ): void => {
    const executionHost = toRuntimeExecutionHostId(environmentId)
    const id = notificationDeliveryId(event.notificationId, executionHost)
    const notice = event.notice
    if (!notice) {
      presented.delete(id)
      void window.api.notifications.dismiss([id])
      return
    }
    const content = { title: notice.title, body: notice.body }
    const signature = JSON.stringify(content)
    if (presented.get(id)?.signature === signature) {
      return
    }
    presented.set(id, { environmentId, signature })
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
      for (const id of presented.keys()) {
        if (presented.get(id)?.environmentId === environmentId && !retained.has(id)) {
          presented.delete(id)
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
    }
  }
}
