import { expect, it } from 'vitest'
import type { NotificationDispatchRequest } from '../../shared/notifications/notification-settings-types'
import { getDefaultNotificationSettings } from '../../shared/notifications/notification-settings-defaults'
import { createNotificationDeliveryService } from './notification-delivery-service'

it('admits each unread agent notification once across native banner toggles', () => {
  let nativeEnabled = false
  const announced: string[] = []
  const service = createNotificationDeliveryService({
    readNotificationSettings: () => ({
      ...getDefaultNotificationSettings(),
      enabled: nativeEnabled
    }),
    findActiveWindow: () => null,
    isWindowVisible: () => false,
    setTrayAttention: () => {},
    isNotificationSupported: () => true,
    dispatchMobileNotification: null,
    readAuthorizationStatus: async () => 'authorized',
    recordDeliveryOutcome: () => {},
    deliverNative: () => ({ delivered: true }),
    platform: 'win32',
    now: () => 100,
    wasRead: (request) => request.attentionKey === 'already-read',
    wantsAgentAttention: () => true,
    emitAgentAttention: (request) => announced.push(request.attentionKey ?? '')
  })
  const completion: NotificationDispatchRequest = {
    source: 'agent-task-complete',
    surface: 'agent-session',
    worktreeId: 'workspace',
    agentState: 'done'
  }

  service.dispatch({ ...completion, attentionKey: 'already-read' })
  expect(service.dispatch({ ...completion, attentionKey: 'first-turn' })).toEqual({
    delivered: false,
    reason: 'disabled'
  })
  service.dispatch({ ...completion, attentionKey: 'first-turn' })
  nativeEnabled = true
  expect(service.dispatch({ ...completion, attentionKey: 'first-turn' })).toEqual({
    delivered: true
  })
  service.dispatch({ ...completion, attentionKey: 'second-turn' })
  nativeEnabled = false
  service.dispatch({ ...completion, attentionKey: 'second-turn' })
  service.dispatch({ source: 'terminal-bell', worktreeId: 'workspace' })

  expect(announced).toEqual(['first-turn', 'second-turn'])
})
