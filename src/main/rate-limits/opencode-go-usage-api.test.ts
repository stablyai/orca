import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock },
  session: { defaultSession: {} }
}))
vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn().mockResolvedValue(undefined)
}))

import { fetchOpenCodeGoUsageWithApiKey, OPENCODE_GO_USAGE_API_URL } from './opencode-go-usage-api'

// Placeholder only — a real key must never reach a fixture.
const API_KEY = 'placeholder-go-key'

function makeResponse(body: string, status = 200): Response {
  return new Response(body, { status })
}

const USAGE_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 30, resetsAt: '2026-09-23T17:00:00.000Z' },
    weekly: { status: 'ok', percent: 51, resetsAt: '2026-09-28T00:00:00.000Z' },
    monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-12T00:00:00.000Z' }
  }
}

describe('fetchOpenCodeGoUsageWithApiKey', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
  })

  it('sends the key as a bearer token and maps every window', async () => {
    netFetchMock.mockResolvedValue(makeResponse(JSON.stringify(USAGE_BODY)))

    const outcome = await fetchOpenCodeGoUsageWithApiKey(API_KEY)

    expect(netFetchMock).toHaveBeenCalledWith(
      OPENCODE_GO_USAGE_API_URL,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` })
      })
    )
    expect(outcome).toEqual({
      kind: 'ok',
      windows: {
        session: {
          usedPercent: 30,
          windowMinutes: 300,
          resetsAt: Date.parse('2026-09-23T17:00:00.000Z'),
          resetDescription: null
        },
        weekly: {
          usedPercent: 51,
          windowMinutes: 10080,
          resetsAt: Date.parse('2026-09-28T00:00:00.000Z'),
          resetDescription: null
        },
        monthly: {
          usedPercent: 100,
          windowMinutes: 43200,
          resetsAt: Date.parse('2026-10-12T00:00:00.000Z'),
          resetDescription: null
        }
      }
    })
  })

  it('keeps usage when the monthly window is absent', async () => {
    netFetchMock.mockResolvedValue(
      makeResponse(
        JSON.stringify({
          usage: { rolling: USAGE_BODY.usage.rolling, weekly: USAGE_BODY.usage.weekly }
        })
      )
    )

    const outcome = await fetchOpenCodeGoUsageWithApiKey(API_KEY)

    expect(outcome.kind).toBe('ok')
    expect(outcome.kind === 'ok' && outcome.windows.monthly).toBeNull()
  })

  it('reports a rejected key as unauthorized', async () => {
    netFetchMock.mockResolvedValue(
      makeResponse(
        JSON.stringify({ type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } }),
        401
      )
    )

    await expect(fetchOpenCodeGoUsageWithApiKey(API_KEY)).resolves.toEqual({ kind: 'unauthorized' })
  })

  it('reports an entitlement refusal as a missing subscription, not a parse failure', async () => {
    netFetchMock.mockResolvedValue(
      makeResponse(
        JSON.stringify({
          type: 'error',
          error: { type: 'EntitlementError', message: 'OpenCode Go subscription required.' }
        }),
        403
      )
    )

    await expect(fetchOpenCodeGoUsageWithApiKey(API_KEY)).resolves.toEqual({
      kind: 'no-subscription'
    })
  })

  it('trusts the error name over the status when a proxied console answers differently', async () => {
    netFetchMock.mockResolvedValue(
      makeResponse(JSON.stringify({ error: { type: 'EntitlementError' } }), 402)
    )

    await expect(fetchOpenCodeGoUsageWithApiKey(API_KEY)).resolves.toEqual({
      kind: 'no-subscription'
    })
  })

  it('reports a sign-in page reached through a redirect as unauthorized', async () => {
    netFetchMock.mockResolvedValue(
      new Response('<!doctype html><title>Log in</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    )

    await expect(fetchOpenCodeGoUsageWithApiKey(API_KEY)).resolves.toEqual({ kind: 'unauthorized' })
  })

  it('reports a malformed success body as a parse failure', async () => {
    netFetchMock.mockResolvedValue(makeResponse('{"usage":{"rolling":{}}}'))

    await expect(fetchOpenCodeGoUsageWithApiKey(API_KEY)).resolves.toEqual({
      kind: 'failed',
      message: 'Could not parse OpenCode Go usage response'
    })
  })

  it('never leaks the key through a network failure message', async () => {
    netFetchMock.mockRejectedValue(new Error(`request to ${OPENCODE_GO_USAGE_API_URL} failed`))

    const outcome = await fetchOpenCodeGoUsageWithApiKey(API_KEY)

    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.message).not.toContain(API_KEY)
  })
})
