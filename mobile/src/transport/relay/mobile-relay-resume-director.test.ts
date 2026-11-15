import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RelayDirectorHttpError,
  RelayDirectorResolveTimeoutError,
  RelayResolveTimeoutBudget,
  resolveMobileRelayEndpoint
} from './mobile-relay-resume-director'

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-old.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

describe('mobile relay resume director', () => {
  it('rejects oversized bodies despite an underreported content length', async () => {
    const oversizedBody =
      ' '.repeat(16 * 1024) +
      JSON.stringify({
        v: 1,
        cellUrl: 'https://relay-c2.onorca.dev',
        assignmentEpoch: 8,
        leaseExpiresAt: 1
      })
    await expect(
      resolveMobileRelayEndpoint({
        relay,
        resumeToken: 'A'.repeat(43),
        fetchImpl: async () => new Response(oversizedBody, { headers: { 'content-length': '1' } })
      })
    ).rejects.toThrow(/too large/)
  })

  afterEach(() => vi.useRealTimers())

  it('names a timed-out resolve so the next one can get a longer budget', async () => {
    vi.useFakeTimers()
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const resolving = resolveMobileRelayEndpoint({
      relay,
      resumeToken: 'A'.repeat(43),
      fetchImpl: hanging,
      timeoutMs: 5_000
    })
    const settled = expect(resolving).rejects.toBeInstanceOf(RelayDirectorResolveTimeoutError)
    await vi.advanceTimersByTimeAsync(5_000)
    await settled
  })
})

describe('RelayResolveTimeoutBudget', () => {
  it('widens 5s to 10s after a timeout and narrows again after a success', () => {
    const budget = new RelayResolveTimeoutBudget()
    expect(budget.timeoutMs).toBe(5_000)
    budget.failed(new RelayDirectorHttpError(503, null))
    expect(budget.timeoutMs).toBe(5_000)
    budget.failed(new RelayDirectorResolveTimeoutError(5_000))
    expect(budget.timeoutMs).toBe(10_000)
    budget.failed(new RelayDirectorHttpError(503, null))
    expect(budget.timeoutMs).toBe(10_000)
    budget.succeeded()
    expect(budget.timeoutMs).toBe(5_000)
  })
})
