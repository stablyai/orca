import { expect, it, vi } from 'vitest'
const state = vi.hoisted(() => {
  const initial: {
    task: null | ((input: unknown) => Promise<void>)
    appState: string
    hosts: unknown[]
  } = { task: null, appState: 'background', hosts: [] }
  return initial
})
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return state.appState
    }
  }
}))
vi.mock('../transport/host-store', () => ({ loadHosts: vi.fn(async () => state.hosts) }))
vi.mock('./push-receive', () => ({ canPresentForegroundPush: vi.fn(async () => true) }))
vi.mock('expo-task-manager', () => ({
  defineTask: (_name: string, task: typeof state.task) => {
    state.task = task
  },
  isAvailableAsync: async () => true
}))
vi.mock('expo-notifications', () => ({
  registerTaskAsync: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(async () => []),
  dismissNotificationAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn()
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
import { registerPushDismissalTask } from './push-background-dismissal'
import { SEALED_VECTOR, sealedVectorHost } from './push-sealed-payload.test-fixture'

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

it('swaps a sealed placeholder for the opened text under the same tag, silently', async () => {
  state.hosts = [sealedVectorHost()]
  state.appState = 'background'
  await registerPushDismissalTask()
  await state.task!({ data: { data: { ...SEALED_VECTOR.fcmData, tag: 'tag-1' } } })
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
    identifier: 'tag-1',
    content: expect.objectContaining({
      title: 'wt - Claude finished',
      body: 'Готово ✓',
      sound: false,
      data: expect.objectContaining({
        notificationId: 'agent:wt:pane:1',
        notificationEpoch: 'epoch-1',
        worktreeId: 'repo::wt'
      })
    }),
    trigger: { channelId: 'orca-desktop-silent' }
  })
  const scheduled = vi.mocked(Notifications.scheduleNotificationAsync).mock.calls[0]?.[0]
  expect(scheduled?.content.data).not.toHaveProperty('paneKey')
})

it('leaves foreground sealed pushes to the foreground presenter', async () => {
  vi.mocked(Notifications.scheduleNotificationAsync).mockClear()
  state.hosts = [sealedVectorHost()]
  state.appState = 'active'
  await registerPushDismissalTask()
  await state.task!({ data: { data: { ...SEALED_VECTOR.fcmData, tag: 'tag-1' } } })
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled()
  state.appState = 'background'
})
