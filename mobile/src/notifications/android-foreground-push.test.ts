import { beforeEach, expect, it, vi } from 'vitest'
import type { Notification } from 'expo-notifications'
import { startAndroidForegroundPushPresentation } from './android-foreground-push'

const mocks = vi.hoisted(() => ({
  platform: { OS: 'android' },
  receive: (_notification: Notification) => {},
  remove: vi.fn(),
  schedule: vi.fn().mockResolvedValue('message-1')
}))
vi.mock('react-native', () => ({ Platform: mocks.platform }))
vi.mock('expo-notifications', () => ({
  addNotificationReceivedListener: (listener: typeof mocks.receive) => {
    mocks.receive = listener
    return { remove: mocks.remove }
  },
  scheduleNotificationAsync: mocks.schedule
}))

function notification(trigger: unknown = { type: 'push', remoteMessage: { notification: null } }) {
  return {
    request: {
      identifier: 'message-1',
      trigger,
      content: {
        title: 'Test notification',
        body: '',
        sound: 'default',
        data: {
          hostFingerprint: 'host',
          notificationId: 'event',
          notificationEpoch: 'epoch',
          notificationSeq: '3',
          paneKey: 'pane',
          channelId: 'orca-desktop'
        }
      }
    }
  } as unknown as Notification
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.platform.OS = 'android'
})

it('presents a title-only data push with its original identity, routing and channel', () => {
  const stop = startAndroidForegroundPushPresentation()
  const incoming = notification()
  mocks.receive(incoming)
  expect(mocks.schedule).toHaveBeenCalledWith({
    identifier: incoming.request.identifier,
    content: incoming.request.content,
    trigger: { channelId: 'orca-desktop' }
  })
  stop()
  expect(mocks.remove).toHaveBeenCalledOnce()
})

it('does not reschedule its own local notification or normal provider notifications', () => {
  startAndroidForegroundPushPresentation()
  mocks.receive(notification(null))
  mocks.receive(notification({ type: 'channel', channelId: 'orca-desktop' }))
  mocks.receive(notification({ type: 'push', remoteMessage: { notification: { title: 'Test' } } }))
  expect(mocks.schedule).not.toHaveBeenCalled()
})

it('leaves silent dismissals and unrelated messages alone', () => {
  startAndroidForegroundPushPresentation()
  const incoming = notification()
  incoming.request.content.data.kind = 'dismiss'
  mocks.receive(incoming)
  incoming.request.content.data = {}
  mocks.receive(incoming)
  expect(mocks.schedule).not.toHaveBeenCalled()
})

it('leaves iOS delivery unchanged', () => {
  mocks.platform.OS = 'ios'
  startAndroidForegroundPushPresentation()()
  expect(mocks.remove).not.toHaveBeenCalled()
})
