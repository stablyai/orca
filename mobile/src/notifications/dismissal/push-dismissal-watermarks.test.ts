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
import {
  rememberPushDismissal,
  rememberPushDismissals,
  wasPushDismissed
} from './push-dismissal-watermarks'
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

it('merges batched and concurrent fences without lowering duplicates or accepting invalid ones', async () => {
  await rememberPushDismissal({ ...payload, notificationSeq: 5 })
  await Promise.all([
    rememberPushDismissals([
      payload,
      { ...payload, notificationSeq: 4 },
      { ...payload, notificationId: 'other' },
      { ...payload, notificationId: 'invalid', notificationSeq: -1 }
    ]),
    rememberPushDismissal({ ...payload, notificationSeq: 7 })
  ])
  expect(await wasPushDismissed({ ...payload, notificationSeq: 7 })).toBe(true)
  expect(await wasPushDismissed({ ...payload, notificationSeq: 8 })).toBe(false)
  expect(await wasPushDismissed({ ...payload, notificationId: 'other' })).toBe(true)
  expect(await wasPushDismissed({ ...payload, notificationId: 'invalid' })).toBe(false)
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
