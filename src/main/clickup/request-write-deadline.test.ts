import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>())
vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({ proxySession: () => null, fetch: fetchMock })
}))

import { CLICKUP_MAX_RATE_LIMIT_WAIT_MS } from '../../shared/clickup-timeouts'
import { noteClickUpRateLimitHeaders, resetClickUpRateLimitStateForTests } from './rate-limit'
import { clickUpRequest } from './request'

const NOW = Date.UTC(2026, 9, 29, 9, 0, 0)
const client = {
  token: 'pk_test',
  workspace: { id: 'team-1', name: 'Team' }
} as Parameters<typeof clickUpRequest>[0]

describe('ClickUp write queue deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    resetClickUpRateLimitStateForTests()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
  })

  afterEach(() => {
    resetClickUpRateLimitStateForTests()
    vi.useRealTimers()
  })

  it('never sends a write that waited past the queue budget its caller allows', async () => {
    // Three slow writes hold every pool slot, so a fourth waits past its budget.
    let finishSlow: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      finishSlow = resolve
    })
    const slow = (): Promise<Response> => gate.then(() => new Response('{}', { status: 200 }))
    fetchMock.mockImplementationOnce(slow).mockImplementationOnce(slow).mockImplementationOnce(slow)
    const held = [1, 2, 3].map((n) =>
      clickUpRequest(client, `/task/held-${n}`, { method: 'PUT', body: '{}' })
    )
    await vi.advanceTimersByTimeAsync(0)
    const late = clickUpRequest(client, '/task/late', { method: 'PUT', body: '{}' })
    const assertion = expect(late).rejects.toThrow('the change was not sent')

    await vi.advanceTimersByTimeAsync(CLICKUP_MAX_RATE_LIMIT_WAIT_MS + 1)
    await assertion
    finishSlow()
    await Promise.all(held)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContainEqual(
      expect.stringContaining('/task/late')
    )
  })

  it('still sends a write once a shorter pause ends', async () => {
    noteClickUpRateLimitHeaders(
      new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 5) }),
      NOW
    )
    const pending = clickUpRequest(client, '/task/abc', { method: 'PUT', body: '{}' })
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(pending).resolves.toEqual({})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
