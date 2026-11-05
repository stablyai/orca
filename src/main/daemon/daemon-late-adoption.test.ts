import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { getDaemonProviderMock } = vi.hoisted(() => ({
  getDaemonProviderMock: vi.fn<() => object | null>(() => null)
}))
vi.mock('./daemon-provider-state', () => ({ getDaemonProvider: getDaemonProviderMock }))

import { LATE_DAEMON_ADOPTION_ATTEMPTS, scheduleLateDaemonAdoption } from './daemon-late-adoption'
import { DEGRADED_DAEMON_RECOVERY_RETRY_MS } from './degraded-daemon-fresh-spawn-routing'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  getDaemonProviderMock.mockReset().mockReturnValue(null)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('retries a failed adoption a bounded number of times and stops once it succeeds', async () => {
  const adopt = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('host not ready'))
    .mockResolvedValueOnce(undefined)
  scheduleLateDaemonAdoption(adopt, () => false)

  expect(adopt).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(DEGRADED_DAEMON_RECOVERY_RETRY_MS)
  expect(adopt).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(DEGRADED_DAEMON_RECOVERY_RETRY_MS)
  expect(adopt).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(DEGRADED_DAEMON_RECOVERY_RETRY_MS * 3)
  expect(adopt).toHaveBeenCalledTimes(2)
})

it('gives up after the last attempt fails', async () => {
  const adopt = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('host not ready'))
  scheduleLateDaemonAdoption(adopt, () => false)

  await vi.advanceTimersByTimeAsync(
    DEGRADED_DAEMON_RECOVERY_RETRY_MS * (LATE_DAEMON_ADOPTION_ATTEMPTS + 2)
  )
  expect(adopt).toHaveBeenCalledTimes(LATE_DAEMON_ADOPTION_ATTEMPTS)
})

it('skips adoption once a provider is installed or the app is quitting', async () => {
  const adopt = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  getDaemonProviderMock.mockReturnValue({})
  scheduleLateDaemonAdoption(adopt, () => false)
  await vi.advanceTimersByTimeAsync(DEGRADED_DAEMON_RECOVERY_RETRY_MS)

  getDaemonProviderMock.mockReturnValue(null)
  scheduleLateDaemonAdoption(adopt, () => true)
  await vi.advanceTimersByTimeAsync(DEGRADED_DAEMON_RECOVERY_RETRY_MS)

  expect(adopt).not.toHaveBeenCalled()
})
