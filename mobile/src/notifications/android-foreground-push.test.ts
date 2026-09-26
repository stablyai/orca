import { beforeEach, expect, it, vi } from 'vitest'
import type {
  FirebaseRemoteMessageNotification,
  Notification,
  NotificationTrigger
} from 'expo-notifications'
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

// Expo's remote-message types are wide and fully required; the two builders below fill them once
// so the fixtures below can be plain `Notification` values rather than assertions.
const REMOTE_NOTIFICATION: FirebaseRemoteMessageNotification = {
  body: null,
  bodyLocalizationArgs: null,
  bodyLocalizationKey: null,
  channelId: null,
  clickAction: null,
  color: null,
  eventTime: null,
  icon: null,
  imageUrl: null,
  lightSettings: null,
  link: null,
  localOnly: false,
  notificationCount: null,
  notificationPriority: null,
  sound: null,
  sticky: false,
  tag: null,
  ticker: null,
  title: null,
  titleLocalizationArgs: null,
  titleLocalizationKey: null,
  usesDefaultLightSettings: false,
  usesDefaultSound: false,
  usesDefaultVibrateSettings: false,
  vibrateTimings: null,
  visibility: null
}

function pushTrigger(remote: FirebaseRemoteMessageNotification | null): NotificationTrigger {
  return {
    type: 'push',
    remoteMessage: {
      collapseKey: null,
      data: {},
      from: null,
      messageId: 'message-1',
      messageType: null,
      notification: remote,
      originalPriority: 1,
      priority: 1,
      sentTime: 0,
      to: null,
      ttl: 0
    }
  }
}

const ORCA_PUSH_DATA: Record<string, unknown> = {
  hostFingerprint: 'host',
  notificationId: 'event',
  notificationEpoch: 'epoch',
  notificationSeq: '3',
  paneKey: 'pane',
  channelId: 'orca-desktop'
}

function notification(
  trigger: NotificationTrigger = pushTrigger(null),
  data: Record<string, unknown> = ORCA_PUSH_DATA
): Notification {
  return {
    date: 0,
    request: {
      identifier: 'message-1',
      trigger,
      content: {
        title: 'Test notification',
        subtitle: null,
        body: '',
        categoryIdentifier: null,
        sound: 'default',
        data
      }
    }
  }
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
  // The four members the presenter forwards, named: it rebuilds content rather than passing the
  // arriving object through, so comparing against the whole fixture would only hold by accident.
  expect(mocks.schedule).toHaveBeenCalledWith({
    identifier: incoming.request.identifier,
    content: {
      title: incoming.request.content.title,
      body: incoming.request.content.body,
      data: incoming.request.content.data,
      sound: 'default'
    },
    trigger: { channelId: 'orca-desktop' }
  })
  stop()
  expect(mocks.remove).toHaveBeenCalledOnce()
})

it('does not reschedule its own local notification or normal provider notifications', () => {
  startAndroidForegroundPushPresentation()
  mocks.receive(notification(null))
  mocks.receive(notification({ channelId: 'orca-desktop' }))
  mocks.receive(notification(pushTrigger({ ...REMOTE_NOTIFICATION, title: 'Test' })))
  expect(mocks.schedule).not.toHaveBeenCalled()
})

it('leaves silent dismissals and unrelated messages alone', () => {
  startAndroidForegroundPushPresentation()
  mocks.receive(notification(undefined, { ...ORCA_PUSH_DATA, kind: 'dismiss' }))
  mocks.receive(notification(undefined, {}))
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
