import {
  RuntimeMobileNotificationController,
  type MobileNotificationDismissEvent
} from './runtime-mobile-notification-controller'

export function captureOriginalDeliveryRetirement(directory: string): {
  originalEpoch: string
  restartedEpoch: string
  event: MobileNotificationDismissEvent
} {
  const original = new RuntimeMobileNotificationController()
  original.configureDismissalStore(directory)
  original.dispatch({
    type: 'notification',
    source: 'agent-task-complete',
    title: 'Allow?',
    body: '',
    notificationId: 'same',
    structuredOrigin: {
      scope: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder',
        workspaceKind: 'folder'
      },
      sessionId: 'session-a',
      journalCursor: { epoch: 'journal-a', sequence: 1 },
      cause: { kind: 'prompt', promptId: 'A' }
    }
  })
  const restarted = new RuntimeMobileNotificationController()
  restarted.configureDismissalStore(directory)
  let event: MobileNotificationDismissEvent | undefined
  restarted.onDispatched((value) => {
    if (value.type === 'dismiss') {
      event = value
    }
  })
  restarted.retireStructuredAttention({
    sessionId: 'session-a',
    observedCursor: { epoch: 'journal-a', sequence: 1 }
  })
  if (!event) {
    throw new Error('read did not withdraw the prompt')
  }
  return { originalEpoch: original.getEpoch(), restartedEpoch: restarted.getEpoch(), event }
}
