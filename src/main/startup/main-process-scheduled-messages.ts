import { randomUUID } from 'node:crypto'
import { ScheduledMessageService } from '../scheduled-message-service'
import { deliverScheduledMessageNotification } from '../scheduled-message-notifications'
import { SCHEDULED_MESSAGES_UPDATE_CHANNEL } from '../../shared/scheduled-message-types'
import { resolveWorktreeAgentPane, sendGuardedAgentPrompt } from '../runtime/agent-pane-delivery'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { mainProcessState as state } from './main-process-state'
import { focusWorktreeFromMain } from './main-window-actions'

export function initializeMainProcessScheduledMessages(
  runtimeService: OrcaRuntimeService
): ScheduledMessageService {
  const activeStore = state.store
  if (!activeStore) {
    throw new Error('Store must be initialized before the scheduled-message service')
  }
  const service = new ScheduledMessageService({
    store: {
      listScheduledMessages: () => activeStore.listScheduledMessages(),
      putScheduledMessage: (message) => activeStore.putScheduledMessage(message),
      deleteScheduledMessage: (messageId) => activeStore.deleteScheduledMessage(messageId)
    },
    resolveAgentPane: (worktreeId) => resolveWorktreeAgentPane(runtimeService, worktreeId),
    deliver: (handle, text, options) =>
      sendGuardedAgentPrompt(runtimeService, handle, text, options),
    isAgentIdle: async (pane) => {
      const status = await runtimeService.getTerminalAgentStatus(pane.handle)
      return status.isRunningAgent && status.status !== 'working'
    },
    createId: () => randomUUID(),
    notify: (notification) =>
      deliverScheduledMessageNotification(notification, {
        getNotificationSettings: () => activeStore.getSettings().notifications,
        focus: (worktreeId) => focusWorktreeFromMain(worktreeId)
      }),
    onSnapshot: (snapshot) =>
      state.mainWindow?.webContents.send(SCHEDULED_MESSAGES_UPDATE_CHANNEL, snapshot)
  })
  state.unsubscribeAgentIdleEdge = runtimeService.subscribeAgentIdleEdge((event) =>
    service.handleIdleEdge(event)
  )
  state.scheduledMessageService = service
  service.start()
  return service
}
