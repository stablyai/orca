import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import type { RetainedAgentAttention } from '../../shared/notifications/notification-settings-types'
import type { NotificationDeliveryService } from './notification-delivery-service'

/** Reconnection restores retained news by id without repeating its external alert. */
export function createRetainedAgentAttentionReceiver(deps: {
  dispatch: NotificationDeliveryService['dispatch']
  dismiss: (id: string) => void
  readWorkspaceSession: () => Pick<
    WorkspaceSessionState,
    'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  >
  /** What the host already retains, presented once now. */
  retained?: readonly RetainedAgentAttention[]
}) {
  const presented = new Map<string, string>()
  const receive = (notificationId: string, notice: RetainedAgentAttention | null): void => {
    if (!notice) {
      presented.delete(notificationId)
      deps.dismiss(notificationId)
      return
    }
    const content = { title: notice.title, body: notice.body }
    const signature = JSON.stringify(content)
    if (presented.get(notificationId) === signature) {
      return
    }
    presented.set(notificationId, signature)
    const session = deps.readWorkspaceSession()
    void deps.dispatch({
      source: 'agent-task-complete',
      agentState: 'waiting',
      content,
      notificationId,
      attentionKey: JSON.stringify([notificationId, content]),
      notificationSourceId: 'local',
      worktreeId: notice.worktreeId,
      paneKey: notice.paneKey,
      workspaceExecutionHostId: null,
      mobileDeliveredByHost: true,
      isActiveWorktree:
        session.activeWorktreeId === notice.worktreeId &&
        !session.activeWorkspaceExecutionHostId?.startsWith('runtime:')
    })
  }
  for (const notice of deps.retained ?? []) {
    receive(notice.notificationId, notice)
  }
  return receive
}
