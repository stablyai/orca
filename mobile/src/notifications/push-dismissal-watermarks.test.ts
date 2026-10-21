import { beforeEach, expect, it, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: async (key: string, value: string) => {
      storage.set(key, value)
    }
  }
}))
import { rememberPushDismissal, wasPushDismissed } from './push-dismissal-watermarks'
const payload = {
  hostFingerprint: 'host-a',
  notificationEpoch: 'epoch-a',
  notificationId: 'note',
  notificationSeq: 2
}
beforeEach(() => {
  storage.clear()
  vi.mocked(AsyncStorage.getItem)
    .mockReset()
    .mockImplementation(async (key) => storage.get(key) ?? null)
  vi.useRealTimers()
})

it('persists dismissal through restart while preserving newer alerts and other hosts or epochs', async () => {
  await rememberPushDismissal(payload)
  vi.resetModules()
  const restarted = await import('./push-dismissal-watermarks')
  expect(await restarted.wasPushDismissed({ ...payload, notificationSeq: 1 })).toBe(true)
  expect(await restarted.wasPushDismissed({ ...payload, notificationSeq: 3 })).toBe(false)
  expect(await restarted.wasPushDismissed({ ...payload, hostFingerprint: 'host-b' })).toBe(false)
  expect(await restarted.wasPushDismissed({ ...payload, notificationEpoch: 'epoch-b' })).toBe(false)
})

it('serializes concurrent dismissals and never lowers a watermark', async () => {
  await Promise.all([
    rememberPushDismissal({ ...payload, notificationSeq: 5 }),
    rememberPushDismissal(payload),
    rememberPushDismissal({ ...payload, notificationId: 'other' })
  ])
  expect(await wasPushDismissed({ ...payload, notificationSeq: 5 })).toBe(true)
  expect(await wasPushDismissed({ ...payload, notificationId: 'other' })).toBe(true)
})

it('expires retained metadata and ignores unversioned dismissals', async () => {
  vi.useFakeTimers()
  await rememberPushDismissal(payload)
  vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000)
  expect(await wasPushDismissed(payload)).toBe(false)
  await rememberPushDismissal({ ...payload, notificationEpoch: undefined })
  expect(await wasPushDismissed(payload)).toBe(false)
})

it('joins an overtaking JavaScript write before retrying a delayed negative snapshot', async () => {
  let finish!: () => void
  vi.mocked(AsyncStorage.getItem).mockImplementationOnce(async (key) => {
    const snapshot = storage.get(key) ?? null
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return snapshot
  })
  const pending = wasPushDismissed(payload)
  await vi.waitFor(() => expect(finish).toBeDefined())
  await rememberPushDismissal(payload)
  finish()
  expect(await pending).toBe(true)
  expect(AsyncStorage.getItem).toHaveBeenCalledTimes(3)
  expect(await wasPushDismissed({ ...payload, notificationSeq: 3 })).toBe(false)
})

it.each([1, 3])('retains live dismissals beyond 512 entries across %i hosts', async (hosts) => {
  for (let index = 0; index < 520; index++) {
    await rememberPushDismissal({
      ...payload,
      hostFingerprint: `host-${index % hosts}`,
      notificationId: `note-${index}`
    })
  }
  vi.resetModules()
  const restarted = await import('./push-dismissal-watermarks')
  for (const index of [0, 1, 519]) {
    const alert = {
      ...payload,
      hostFingerprint: `host-${index % hosts}`,
      notificationId: `note-${index}`
    }
    expect(await restarted.wasPushDismissed(alert)).toBe(true)
    expect(await restarted.wasPushDismissed({ ...alert, notificationSeq: 3 })).toBe(false)
  }
})
