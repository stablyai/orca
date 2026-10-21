import { afterEach, expect, it, vi } from 'vitest'
import { AppState } from 'react-native'
import { startMobilePushLeaseRenewal } from './mobile-push-lease-renewal'

let onChange: (state: string) => void
const remove = vi.fn()
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_: string, callback: typeof onChange) => {
      onChange = callback
      return { remove }
    }
  }
}))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('renews only while mobile is foregrounded, resumes on return, and tears down', async () => {
  vi.useFakeTimers()
  AppState.currentState = 'active'
  const renew = vi.fn(async () => {})
  const stop = startMobilePushLeaseRenewal(renew)
  await vi.advanceTimersByTimeAsync(15 * 60_000)
  expect(renew).toHaveBeenCalledTimes(1)
  AppState.currentState = 'background'
  onChange('background')
  await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60_000)
  expect(renew).toHaveBeenCalledTimes(1)
  AppState.currentState = 'active'
  onChange('active')
  expect(renew).toHaveBeenCalledTimes(2)
  stop()
  await vi.advanceTimersByTimeAsync(15 * 60_000)
  expect(renew).toHaveBeenCalledTimes(2)
  expect(remove).toHaveBeenCalledOnce()
})
