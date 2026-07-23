import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RELAY_CONTROL_MAX_PENDING_REQUESTS,
  RELAY_CONTROL_REQUEST_ID_MAX_UTF8_BYTES,
  RelayControlRequests
} from './relay-control-requests'

afterEach(() => {
  vi.useRealTimers()
})

describe('RelayControlRequests admission', () => {
  it('fails closed at the pending request cap', async () => {
    vi.useFakeTimers()
    const requests = new RelayControlRequests()
    const send = vi.fn()
    const admitted = Array.from({ length: RELAY_CONTROL_MAX_PENDING_REQUESTS }, (_, index) =>
      requests.createInvite(`request-${index}`, 'device-a', send)
    )
    const settlements = Promise.allSettled(admitted)

    await expect(requests.createInvite('request-overflow', 'device-a', send)).rejects.toThrow(
      'relay_control_request_limit'
    )
    expect(requests.size).toBe(RELAY_CONTROL_MAX_PENDING_REQUESTS)
    expect(send).toHaveBeenCalledTimes(RELAY_CONTROL_MAX_PENDING_REQUESTS)

    requests.rejectAll(new Error('closed'))
    await settlements
    expect(requests.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an oversized request id before sending or retaining it', async () => {
    const requests = new RelayControlRequests()
    const send = vi.fn()

    await expect(
      requests.createInvite('🙂'.repeat(RELAY_CONTROL_REQUEST_ID_MAX_UTF8_BYTES), 'device-a', send)
    ).rejects.toThrow('relay_control_request_limit')

    expect(requests.size).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('releases admission when send throws', async () => {
    vi.useFakeTimers()
    const requests = new RelayControlRequests()

    await expect(
      requests.createInvite('request-a', 'device-a', () => {
        throw new Error('send failed')
      })
    ).rejects.toThrow('send failed')

    expect(requests.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases admission when a request times out', async () => {
    vi.useFakeTimers()
    const requests = new RelayControlRequests()
    const result = requests.createInvite('request-a', 'device-a', () => {})
    const rejection = expect(result).rejects.toThrow('relay_control_request_timeout')

    await vi.advanceTimersByTimeAsync(10_000)

    await rejection
    expect(requests.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
