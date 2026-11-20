import { afterEach, expect, it, vi } from 'vitest'
import { setMainUiLanguage } from '../i18n/main-i18n'
import { getDefaultNotificationSettings } from '../../shared/notifications/notification-settings-defaults'
import { createNotificationDeliveryService } from './notification-delivery-service'

vi.mock('electron', () => ({}))

afterEach(async () => {
  await setMainUiLanguage('en')
})

it("formats a failed turn's usage-limit reset clock in the UI language, not the OS locale", async () => {
  const resetsAt = new Date()
  resetsAt.setHours(15, 0, 0, 0)
  const bodies: string[] = []
  const service = createNotificationDeliveryService({
    readNotificationSettings: getDefaultNotificationSettings,
    findActiveWindow: () => null,
    isWindowVisible: () => true,
    setTrayAttention: () => {},
    isNotificationSupported: () => false,
    dispatchMobileNotification: (notification) => {
      if (notification.type === 'notification') {
        bodies.push(notification.body)
      }
    },
    readAuthorizationStatus: async () => null,
    recordDeliveryOutcome: () => {},
    deliverNative: () => ({ delivered: true }),
    platform: 'darwin',
    now: () => resetsAt.getTime()
  })
  const request = {
    source: 'agent-task-complete',
    worktreeId: 'wt-1',
    agentType: 'codex',
    agentState: 'done',
    agentTurnOutcome: 'failure',
    agentFailure: {
      kind: 'usageLimitReached',
      usageLimit: { window: 'weekly', resetsAt: resetsAt.getTime() }
    }
  } as const

  await setMainUiLanguage('de')
  await service.dispatch({ ...request, attentionKey: 'de' })
  await setMainUiLanguage('en')
  await service.dispatch({ ...request, attentionKey: 'en' })

  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toContain('15:00')
  expect(bodies[1]).toMatch(/3:00\sPM/u)
})
