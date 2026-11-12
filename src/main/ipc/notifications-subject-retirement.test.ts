import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationDispatchEvent,
  type MobileNotificationEvent
} from '../runtime/push/notifications/runtime-mobile-notification-controller'
import type { StructuredAttentionState } from '../../shared/agent-session/agent-session-attention'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDismissHandler, resetNotificationDispatchMocks } from './notifications-test-harness'

vi.mock('electron', async () =>
  (await import('./notifications-test-harness')).createElectronModuleMock()
)

vi.mock('./notification-authorization-status', async () =>
  (await import('./notifications-test-harness')).createNotificationAuthorizationModuleMock()
)

vi.mock('./ui', async () =>
  (await import('./notifications-test-harness')).createTrustedUIRendererModuleMock()
)

vi.mock('../tray/system-tray', async () =>
  (await import('./notifications-test-harness')).createSystemTrayModuleMock()
)

import { registerNotificationHandlers } from './notifications'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function register(
  options: { suppressWhenFocused: boolean },
  controller?: RuntimeMobileNotificationController
): {
  dispatchMobileNotification: ReturnType<typeof vi.fn>
  dismissMobileNotification: ReturnType<typeof vi.fn>
} {
  const dispatchMobileNotification = vi.fn((event: MobileNotificationDispatchEvent) =>
    controller?.dispatch(event)
  )
  const dismissMobileNotification = vi.fn((id: string) => controller?.dismiss(id))
  const reconcileStructuredPromptAttention = (state: StructuredAttentionState) =>
    controller?.reconcileStructuredPromptAttention(state)
  registerNotificationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only getSettings; Store is a class, so a structural double needs the cast.
    {
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          agentNeedsInput: true,
          terminalBell: true,
          suppressWhenFocused: options.suppressWhenFocused
        }
      })
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the notification handlers call only these four runtime methods.
    {
      dispatchMobileNotification,
      dismissMobileNotification,
      retireNotificationAttention: controller?.acknowledgeAttention.bind(controller),
      reconcileStructuredPromptAttention
    } as never
  )
  return { dispatchMobileNotification, dismissMobileNotification }
}

describe('notifications:dismiss by acknowledged subject', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    resetNotificationDispatchMocks()
  })

  // Reads rebuild ids for turns that never alerted; each forwarded one was a silent push and a store slot.
  it('clears on the phone only alerts that reached it, including ones sent before a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-clear-delivered-'))
    const original = new RuntimeMobileNotificationController()
    const restarted = new RuntimeMobileNotificationController()
    try {
      original.configureDismissalStore(directory)
      original.dispatch({
        type: 'notification',
        source: 'agent-task-complete',
        title: 'Done',
        body: '',
        notificationId: 'agent:sent'
      })
      await original.closeDismissals()
      restarted.configureDismissalStore(directory)
      const events: MobileNotificationEvent[] = []
      restarted.onDispatched((event) => events.push(event))
      register({ suppressWhenFocused: false }, restarted)
      getDismissHandler()({}, ['agent:never-sent', 'agent:sent'], [PANE])
      getDismissHandler()({}, ['agent:sent'], [PANE])
      expect(events.map((event) => [event.type, event.notificationId])).toEqual([
        ['dismiss', 'agent:sent']
      ])
    } finally {
      await restarted.closeDismissals()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // Positioned alerts survive reads before their journal boundary; pane-wide views cannot retire them.
})
