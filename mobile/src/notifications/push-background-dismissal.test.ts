import { expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ task: null as null | ((input: unknown) => Promise<void>) }))
vi.mock('expo-task-manager', () => ({
  defineTask: (_name: string, task: typeof state.task) => {
    state.task = task
  },
  isAvailableAsync: async () => true
}))
vi.mock('expo-notifications', () => ({ registerTaskAsync: vi.fn() }))
vi.mock('./push-tray-dismissal', () => ({ dismissPresentedPushNotification: vi.fn() }))
import { dismissPresentedPushNotification } from './push-tray-dismissal'
import { registerPushDismissalTask } from './push-background-dismissal'

it('handles native background JSON and scopes dismissal to the originating host', async () => {
  await registerPushDismissalTask()
  await state.task!({
    data: {
      data: {
        dataString: JSON.stringify({
          kind: 'dismiss',
          hostFingerprint: 'host-a',
          notificationId: 'same-id'
        })
      }
    }
  })
  expect(dismissPresentedPushNotification).toHaveBeenCalledWith(
    'same-id',
    'host-a',
    expect.objectContaining({ kind: 'dismiss' })
  )
})

it('does not turn ordinary alerts into dismissals', async () => {
  vi.mocked(dismissPresentedPushNotification).mockClear()
  await state.task!({
    data: { data: { orca: { hostFingerprint: 'host-a', notificationId: 'same-id' } } }
  })
  expect(dismissPresentedPushNotification).not.toHaveBeenCalled()
})
