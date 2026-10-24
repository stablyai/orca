import { vi } from 'vitest'
import type {
  RuntimeMobileNotificationController,
  MobileNotificationDispatchEvent
} from '../runtime/runtime-mobile-notification-controller'
import type {
  StructuredAttentionRead,
  StructuredAttentionState
} from '../../shared/agent-session-attention'
import { registerNotificationHandlers } from './notifications'

export function registerSubjectRetirement(
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
  const retireStructuredAttention = (read: StructuredAttentionRead) =>
    controller?.retireStructuredAttention(read)
  const reconcileStructuredPromptAttention = (state: StructuredAttentionState) =>
    controller?.reconcileStructuredPromptAttention(state)
  registerNotificationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only getSettings; Store is a class, so a structural double needs the cast.
    {
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: options.suppressWhenFocused
        }
      })
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the notification handlers call only these four runtime methods.
    {
      dispatchMobileNotification,
      announcedNotifications: controller?.announcedNotifications,
      dismissMobileNotification,
      retireStructuredAttention,
      retireLiveNotifications: (
        alerts: Parameters<RuntimeMobileNotificationController['retireLiveNotifications']>[0]
      ) => controller?.retireLiveNotifications(alerts),
      reconcileStructuredPromptAttention
    } as never
  )
  return { dispatchMobileNotification, dismissMobileNotification }
}
