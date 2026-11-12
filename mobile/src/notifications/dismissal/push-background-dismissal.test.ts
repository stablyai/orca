import { expect, it, vi } from 'vitest'
const state = vi.hoisted(
  (): { taskName: string; task: null | ((input: unknown) => Promise<void>) } => ({
    taskName: '',
    task: null
  })
)
vi.mock('expo-task-manager', () => ({
  defineTask: (name: string, task: typeof state.task) => {
    state.taskName = name
    state.task = task
  },
  isAvailableAsync: async () => true
}))
vi.mock('expo-notifications', () => ({
  registerTaskAsync: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(async () => []),
  dismissNotificationAsync: vi.fn()
}))
vi.mock('./push-tray-dismissal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./push-tray-dismissal')>()
  return {
    ...actual,
    dismissPresentedPushNotification: vi.fn(actual.dismissPresentedPushNotification)
  }
})
import * as Notifications from 'expo-notifications'
import { dismissPresentedPushNotification } from './push-tray-dismissal'
import './push-background-dismissal'

it('does not turn ordinary alerts into dismissals', async () => {
  vi.mocked(dismissPresentedPushNotification).mockClear()
  await state.task!({
    data: { data: { orca: { hostFingerprint: 'host-a', notificationId: 'same-id' } } }
  })
  expect(dismissPresentedPushNotification).not.toHaveBeenCalled()
})

it('an ID-only background dismissal preserves versioned tray alerts', async () => {
  const base = { hostFingerprint: 'host-a', notificationId: 'same-id' }
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
    { request: { identifier: 'legacy', content: { data: base } } },
    {
      request: {
        identifier: 'versioned',
        content: {
          data: {
            ...base,
            notificationEpoch: 'epoch',
            notificationSeq: 3
          }
        }
      }
    }
  ] as never)
  await state.task!({ data: { data: { ...base, kind: 'dismiss' } } })
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledExactlyOnceWith('legacy')
})
