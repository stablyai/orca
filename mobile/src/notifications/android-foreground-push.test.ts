import { beforeEach, expect, it, vi } from 'vitest'
import type { Notification } from 'expo-notifications'
import { startAndroidForegroundPushPresentation } from './android-foreground-push'

const mocks = vi.hoisted(() => ({
  platform: { OS: 'android' },
  receive: (_notification: Notification) => {},
  remove: vi.fn(),
  eligible: vi.fn().mockResolvedValue(true),
  schedule: vi.fn().mockResolvedValue('message-1')
}))
vi.mock('./push-receive', () => ({ canPresentForegroundPush: mocks.eligible }))
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
  mocks.eligible.mockReset().mockResolvedValue(true)
  mocks.platform.OS = 'android'
})

it('presents a title-only data push with its original identity, routing and channel', async () => {
  const stop = startAndroidForegroundPushPresentation()
  const incoming = notification()
  mocks.receive(incoming)
  await vi.waitFor(() => expect(mocks.schedule).toHaveBeenCalledOnce())
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

it('waits for eligibility before scheduling, even if native presentation will bypass JS', async () => {
  let resolve!: (eligible: boolean) => void
  mocks.eligible.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done
    })
  )
  startAndroidForegroundPushPresentation()
  mocks.receive(notification())
  expect(mocks.schedule).not.toHaveBeenCalled()
  // Model a dismissal arriving while the eligibility reads are in flight.
  resolve(false)
  await Promise.resolve()
  expect(mocks.schedule).not.toHaveBeenCalled()
})

it('does not schedule when eligibility cannot be read', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.eligible.mockRejectedValueOnce(new Error('storage unavailable'))
  startAndroidForegroundPushPresentation()
  mocks.receive(notification())
  await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
  expect(mocks.schedule).not.toHaveBeenCalled()
  warn.mockRestore()
})
