import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../../../network/http-client'
import { fetchOpenCodeGoUsageWithApiKey } from './opencode-go-usage-api'

const ENTITLEMENT_BODY = JSON.stringify({
  type: 'error',
  error: { type: 'EntitlementError', message: 'OpenCode Go subscription required.' }
})

function respondWith(status: number, body: string, contentType: string): void {
  setMainHttpClient({
    fetch: async () => new Response(body, { status, headers: { 'Content-Type': contentType } }),
    proxySession: () => null
  })
}

describe('fetchOpenCodeGoUsageWithApiKey failure classification', () => {
  afterEach(() => setMainHttpClient(null))

  it.each([
    ['entitlement 403', 403, ENTITLEMENT_BODY, 'application/json', 'no-subscription'],
    ['edge block page', 403, '<html><title>Access denied</title></html>', 'text/html', 'failed']
  ])('maps %s to its outcome', async (_case, status, body, contentType, kind) => {
    respondWith(status, body, contentType)
    const outcome = await fetchOpenCodeGoUsageWithApiKey('placeholder-go-key')
    expect(outcome.kind).toBe(kind)
  })
})

const USAGE_BODY = JSON.stringify({
  usage: {
    rolling: { percent: 12.5, resetsAt: '2026-11-27T00:00:00.000Z' },
    weekly: { percent: 40, resetsAt: '2026-12-01T00:00:00.000Z' },
    monthly: { percent: 7, resetsAt: '2026-12-26T00:00:00.000Z' }
  }
})

function failTransportThen(error: Error, failures: number, onCall?: () => void): () => number {
  let calls = 0
  setMainHttpClient({
    fetch: async () => {
      calls += 1
      onCall?.()
      if (calls <= failures) {
        throw error
      }
      return new Response(USAGE_BODY, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    },
    proxySession: () => null
  })
  return () => calls
}

function nodeFetchFailure(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) })
}

describe('fetchOpenCodeGoUsageWithApiKey transport failures', () => {
  beforeEach(async () => {
    // A successful poll clears the failure streak left by earlier cases.
    failTransportThen(new Error('unused'), 0)
    await fetchOpenCodeGoUsageWithApiKey('placeholder-go-key')
  })

  afterEach(() => {
    setMainHttpClient(null)
    vi.useRealTimers()
  })

  it.each([
    ['Electron net.fetch reset', new Error('net::ERR_CONNECTION_RESET')],
    [
      'Node Happy Eyeballs timeout',
      new TypeError('fetch failed', {
        cause: Object.assign(new AggregateError([new Error('ETIMEDOUT')], 'connect failed'), {
          code: 'ETIMEDOUT'
        })
      })
    ]
  ])('retries a brief %s', async (_case, error) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls = failTransportThen(error, 1)
    const outcome = fetchOpenCodeGoUsageWithApiKey('placeholder-go-key')
    await vi.runAllTimersAsync()
    expect((await outcome).kind).toBe('ok')
    expect(calls()).toBe(2)
  })

  it.each([
    ['Node DNS failure', nodeFetchFailure('ENOTFOUND')],
    ['Node fetch without a cause', new TypeError('fetch failed')],
    ['Electron offline', new Error('net::ERR_INTERNET_DISCONNECTED')]
  ])('fails at once on a %s', async (_case, error) => {
    const calls = failTransportThen(error, Infinity)
    const outcome = await fetchOpenCodeGoUsageWithApiKey('placeholder-go-key')
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'network' })
    expect(calls()).toBe(1)
  })

  it('gives up after three attempts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls = failTransportThen(nodeFetchFailure('ECONNRESET'), Infinity)
    const outcome = fetchOpenCodeGoUsageWithApiKey('placeholder-go-key')
    await vi.runAllTimersAsync()
    expect(await outcome).toMatchObject({
      kind: 'failed',
      message: 'OpenCode Go usage request failed (TypeError)',
      failureKind: 'network'
    })
    expect(calls()).toBe(3)
  })

  it('makes one attempt when the previous poll also failed in transport', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls = failTransportThen(nodeFetchFailure('ECONNRESET'), Infinity)
    const firstPoll = fetchOpenCodeGoUsageWithApiKey('placeholder-go-key')
    await vi.runAllTimersAsync()
    await firstPoll
    expect(calls()).toBe(3)

    const secondPoll = fetchOpenCodeGoUsageWithApiKey('placeholder-go-key')
    await vi.runAllTimersAsync()
    expect(await secondPoll).toMatchObject({ kind: 'failed', failureKind: 'network' })
    expect(calls()).toBe(4)
  })

  it('stops retrying once the caller aborts', async () => {
    const controller = new AbortController()
    const calls = failTransportThen(nodeFetchFailure('ECONNRESET'), Infinity, () =>
      setTimeout(() => controller.abort(), 0)
    )
    const outcome = await fetchOpenCodeGoUsageWithApiKey('placeholder-go-key', controller.signal)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'network' })
    expect(calls()).toBe(1)
  })
})
