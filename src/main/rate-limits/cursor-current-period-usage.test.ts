import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import { fetchCursorRateLimits } from './cursor-fetcher'
import type { CursorAuthReadResult } from './cursor-auth'

const fetchMock = vi.fn<typeof fetch>()
const SUMMARY_URL = 'https://cursor.com/api/usage-summary'
const CURRENT_PERIOD_URL = 'https://cursor.com/api/dashboard/get-current-period-usage'
const START = '2026-10-18T06:32:13.504Z'
const END = '2026-10-25T06:32:13.504Z'
const PERCENT = 1.112013719649788
const CURRENT = {
  billingCycleStart: START,
  billingCycleEnd: END,
  planUsage: { totalPercentUsed: PERCENT, autoPercentUsed: PERCENT, apiPercentUsed: 0 }
}
const SUMMARY = {
  membershipType: 'unified_ultra',
  billingCycleStart: '2026-10-01T00:00:00.000Z',
  billingCycleEnd: '2026-11-01T00:00:00.000Z',
  individualUsage: {
    plan: {
      enabled: true,
      used: 0,
      limit: 55395,
      totalPercentUsed: 0,
      autoPercentUsed: 0,
      apiPercentUsed: 0
    }
  }
}
const AUTH: CursorAuthReadResult = {
  status: 'ok',
  session: {
    token: { raw: 'test-cli-token', subject: 'test-cli-account', expiresAtMs: 4_000_000_000_000 },
    source: 'keychain',
    email: null,
    displayName: null,
    membershipType: null,
    subscriptionStatus: null
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  setMainHttpClient({ fetch: fetchMock, proxySession: () => null })
})

afterEach(() => setMainHttpClient(null))

function respond(current: unknown = CURRENT, summary: unknown = SUMMARY): void {
  fetchMock.mockImplementation(async (url) => {
    if (url === SUMMARY_URL) {
      return Response.json(summary)
    }
    if (url === CURRENT_PERIOD_URL) {
      return Response.json(current)
    }
    throw new Error('Unexpected request')
  })
}

describe('Cursor Unified Ultra current-period usage', () => {
  it('replaces stale zero monthly figures with both current weekly pools using the same credential', async () => {
    respond()
    const limits = await fetchCursorRateLimits({ authReadResult: AUTH })
    expect(limits).toMatchObject({ status: 'ok', planType: 'unified_ultra' })
    expect(limits.buckets).toEqual([
      expect.objectContaining({
        name: 'Cursor Models',
        usedPercent: PERCENT,
        windowMinutes: 10080,
        resetsAt: Date.parse(END)
      }),
      expect.objectContaining({
        name: 'Other Models',
        usedPercent: 0,
        windowMinutes: 10080,
        resetsAt: Date.parse(END)
      })
    ])
    expect(limits.monthly).toMatchObject({
      usedPercent: PERCENT,
      windowMinutes: 10080,
      resetsAt: Date.parse(END)
    })
    expect(limits.usageMetadata).toMatchObject({ source: 'cli', credentialSource: 'keychain' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const summaryRequest = fetchMock.mock.calls.find(([url]) => url === SUMMARY_URL)?.[1]
    const currentRequest = fetchMock.mock.calls.find(([url]) => url === CURRENT_PERIOD_URL)?.[1]
    expect(currentRequest).toMatchObject({
      method: 'POST',
      body: '{}',
      redirect: 'manual',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'WorkosCursorSessionToken=test-cli-account%3A%3Atest-cli-token',
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard'
      }
    })
    expect(new Headers(summaryRequest?.headers).get('Cookie')).toBe(
      new Headers(currentRequest?.headers).get('Cookie')
    )
  })

  it('keeps a genuine zero current period authoritative and preserves independently billed on-demand usage', async () => {
    respond(
      { ...CURRENT, planUsage: { totalPercentUsed: '0', autoPercentUsed: '0', apiPercentUsed: 0 } },
      {
        ...SUMMARY,
        individualUsage: {
          plan: { ...SUMMARY.individualUsage.plan, totalPercentUsed: 80, autoPercentUsed: 80 },
          onDemand: { enabled: true, used: 25, limit: 100 }
        }
      }
    )
    const limits = await fetchCursorRateLimits({ authReadResult: AUTH })
    expect(limits.monthly?.usedPercent).toBe(0)
    expect(limits.buckets).toEqual([
      expect.objectContaining({ name: 'Cursor Models', usedPercent: 0, resetsAt: Date.parse(END) }),
      expect.objectContaining({ name: 'Other Models', usedPercent: 0, resetsAt: Date.parse(END) }),
      expect.objectContaining({
        name: 'On-demand',
        usedPercent: 25,
        resetsAt: Date.parse(SUMMARY.billingCycleEnd)
      })
    ])
  })

  it.each([
    null,
    {},
    { ...CURRENT, planUsage: null },
    { ...CURRENT, planUsage: { totalPercentUsed: 'invalid', autoPercentUsed: null } },
    { ...CURRENT, billingCycleStart: 'invalid' },
    { ...CURRENT, billingCycleEnd: START }
  ])(
    'retains summary compatibility when the current-period shape is unusable: %j',
    async (current) => {
      respond(current)
      const limits = await fetchCursorRateLimits({ authReadResult: AUTH })
      expect(limits.status).toBe('ok')
      expect(limits.monthly).toMatchObject({
        usedPercent: 0,
        resetsAt: Date.parse(SUMMARY.billingCycleEnd)
      })
      expect(fetchMock.mock.calls.some(([url]) => url === CURRENT_PERIOD_URL)).toBe(true)
    }
  )

  it.each([
    ['HTTP 404', () => new Response(null, { status: 404 })],
    ['HTTP 405', () => new Response(null, { status: 405 })],
    ['HTTP 501', () => new Response(null, { status: 501 })],
    // Cursor answers unknown dashboard routes with its HTML app shell.
    [
      '200 HTML',
      () => new Response('<!DOCTYPE html>', { headers: { 'content-type': 'text/html' } })
    ]
  ])(
    'falls back to legacy request quota when current-period is unsupported (%s)',
    async (_label, currentResponse) => {
      fetchMock.mockImplementation(async (url) => {
        if (url === SUMMARY_URL) {
          return Response.json({ membershipType: 'unified_ultra' })
        }
        if (url === CURRENT_PERIOD_URL) {
          return currentResponse()
        }
        return Response.json({ 'gpt-4': { numRequests: 25, maxRequestUsage: 50 } })
      })
      const limits = await fetchCursorRateLimits({ authReadResult: AUTH })
      expect(limits.monthly?.usedPercent).toBe(50)
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        SUMMARY_URL,
        CURRENT_PERIOD_URL,
        'https://cursor.com/api/usage?user=test-cli-account'
      ])
    }
  )

  it.each([401, 403, 429, 503])(
    'preserves current-period HTTP %i instead of publishing obsolete healthy zeros',
    async (status) => {
      fetchMock.mockImplementation(async (url) =>
        url === SUMMARY_URL
          ? Response.json(SUMMARY)
          : new Response(null, { status, headers: { 'retry-after': '60' } })
      )
      const limits = await fetchCursorRateLimits({ authReadResult: AUTH })
      expect(limits.status).toBe('error')
      expect(limits.monthly).toBeUndefined()
      expect(limits.usageMetadata?.authProvenance).toBeTruthy()
      expect(limits.usageMetadata?.failureKind).toBe(
        status === 401 ? 'stale-token' : status === 429 ? 'rate-limited' : 'server'
      )
      if (status === 429) {
        expect(limits.usageMetadata?.retryAtMs).toBeGreaterThan(Date.now())
      }
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
  )

  it('does not publish obsolete zeros after a failed current-period request', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === SUMMARY_URL) {
        return Response.json(SUMMARY)
      }
      throw new Error('test network failure')
    })
    const limits = await fetchCursorRateLimits({ authReadResult: AUTH })
    expect(limits.status).toBe('error')
    expect(limits.usageMetadata?.failureKind).toBe('network')
    expect(limits.monthly).toBeUndefined()
  })

  it('keeps an active non-unified plan on the summary without the extra request', async () => {
    const plan = { ...SUMMARY.individualUsage.plan, totalPercentUsed: 12, autoPercentUsed: 12 }
    respond(CURRENT, { ...SUMMARY, membershipType: 'pro', individualUsage: { plan } })
    const limits = await fetchCursorRateLimits({ authReadResult: AUTH })
    expect(limits.planType).toBe('pro')
    expect(limits.monthly?.resetsAt).toBe(Date.parse(SUMMARY.billingCycleEnd))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps an unlimited non-unified plan barless without the extra request', async () => {
    respond(CURRENT, { ...SUMMARY, membershipType: 'enterprise', isUnlimited: true })
    const limits = await fetchCursorRateLimits({ authReadResult: AUTH })
    expect(limits).toMatchObject({ status: 'ok', planType: 'enterprise' })
    expect(limits.monthly).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // Weekly plans are not all unified_*: e.g. an enterprise seat moved to weekly Premium.
  it('uses a weekly current period behind idle non-unified summary pools', async () => {
    const endMs = Date.parse(END)
    const weekly = {
      ...CURRENT,
      billingCycleStart: String(Date.parse(START)),
      billingCycleEnd: String(endMs)
    }
    respond(weekly, { ...SUMMARY, membershipType: 'enterprise' })
    const limits = await fetchCursorRateLimits({ authReadResult: AUTH })
    expect(limits).toMatchObject({ status: 'ok', planType: 'enterprise' })
    expect(limits.monthly).toMatchObject({
      usedPercent: PERCENT,
      windowMinutes: 10080,
      resetsAt: endMs
    })
  })

  it.each([
    [
      'a monthly period',
      () =>
        Response.json({
          ...CURRENT,
          billingCycleStart: SUMMARY.billingCycleStart,
          billingCycleEnd: SUMMARY.billingCycleEnd,
          planUsage: { totalPercentUsed: 9 }
        })
    ],
    ['HTTP 429', () => new Response(null, { status: 429 })],
    ['a network failure', () => Promise.reject(new Error('test network failure'))]
  ])(
    'keeps idle non-unified summary pools when current-period returns %s',
    async (_label, current) => {
      fetchMock.mockImplementation(async (url) =>
        url === SUMMARY_URL ? Response.json({ ...SUMMARY, membershipType: 'pro' }) : current()
      )
      const limits = await fetchCursorRateLimits({ authReadResult: AUTH })
      expect(limits.status).toBe('ok')
      expect(limits.monthly).toMatchObject({
        usedPercent: 0,
        resetsAt: Date.parse(SUMMARY.billingCycleEnd)
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
  )
})
