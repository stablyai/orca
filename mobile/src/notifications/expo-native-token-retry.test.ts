import { beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => vi.fn())
vi.mock('expo-modules-core', () => ({ Platform: { OS: 'ios' }, UnavailabilityError: Error }))
vi.mock('expo-notifications/build/PushTokenManager', () => ({
  default: { getDevicePushTokenAsync: native }
}))
vi.mock('expo-notifications/build/warnOfExpoGoPushUsage', () => ({
  warnOfExpoGoPushUsage: () => {}
}))

beforeEach(() => {
  vi.resetModules()
  native.mockReset()
})

it('releases a failed Expo native-token request so the next attempt can succeed', async () => {
  const { getDevicePushTokenAsync } =
    await import('expo-notifications/build/getDevicePushTokenAsync')
  native.mockRejectedValueOnce(new Error('APNs unavailable')).mockResolvedValueOnce('device-token')
  await expect(getDevicePushTokenAsync()).rejects.toThrow('APNs unavailable')
  await expect(getDevicePushTokenAsync()).resolves.toEqual({ type: 'ios', data: 'device-token' })
  expect(native).toHaveBeenCalledTimes(2)
})

it('still shares one pending native request between concurrent callers', async () => {
  const { getDevicePushTokenAsync } =
    await import('expo-notifications/build/getDevicePushTokenAsync')
  let resolve!: (token: string) => void
  native.mockReturnValue(
    new Promise<string>((done) => {
      resolve = done
    })
  )
  const first = getDevicePushTokenAsync()
  const second = getDevicePushTokenAsync()
  expect(native).toHaveBeenCalledOnce()
  resolve('device-token')
  expect(await first).toEqual(await second)
})
