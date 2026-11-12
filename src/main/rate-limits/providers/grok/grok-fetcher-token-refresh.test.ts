import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../../../network/http-client'

const fetchMock = vi.fn()
const authState = vi.hoisted<{ file: string | null }>(() => ({ file: null }))

vi.mock('node:fs', () => ({
  existsSync: () => authState.file !== null,
  readFileSync: () => {
    if (authState.file === null) {
      throw new Error('ENOENT')
    }
    return authState.file
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

const resolveGrokCommand = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null))

vi.mock('../../../ipc/command-path/command-path-resolver', () => ({
  resolveCommandOnLocalPath: resolveGrokCommand
}))

vi.mock('../../../runtime/agent-session/environment/structured-agent-shell-environment', () => ({
  hostShellEnvironment: vi.fn(async () => ({ PATH: '/usr/bin' }))
}))

const runGrokCommand = vi.hoisted(() => vi.fn())

vi.mock('@orca/process-host', () => ({ runProcess: runGrokCommand }))

import { fetchGrokRateLimits } from './grok-fetcher'
import { resetGrokSessionRefreshForTests } from './grok-session-refresh'
import {
  bindGrokTokenRefreshSchedule,
  clearGrokTokenRefreshSchedule
} from './grok-token-refresh-schedule'

setMainHttpClient({ fetch: fetchMock, proxySession: () => null })

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

const BILLING_RESPONSE = {
  config: {
    creditUsagePercent: 42,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-06-30T18:36:14.268512+00:00',
      end: '2026-07-07T18:36:14.268512+00:00'
    },
    subscriptionTier: 'SuperGrok',
    isUnifiedBillingUser: true
  }
}

function freshAuthJson(): string {
  return JSON.stringify({
    'https://auth.x.ai::client': {
      key: 'access-token',
      user_id: 'user-1',
      email: 'dev@example.com',
      expires_at: '2099-01-01T00:00:00.000Z'
    }
  })
}

describe('fetchGrokRateLimits token refresh', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    runGrokCommand.mockReset()
    resolveGrokCommand.mockReset()
    resolveGrokCommand.mockResolvedValue(null)
    authState.file = null
  })

  afterEach(() => {
    clearGrokTokenRefreshSchedule()
    resetGrokSessionRefreshForTests()
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('runs grok sessions list before a token expires and then reads the refreshed session', async () => {
    authState.file = JSON.stringify({
      'https://auth.x.ai::client': {
        key: 'stale',
        expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString()
      }
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(BILLING_RESPONSE))

    resolveGrokCommand.mockResolvedValue('/usr/bin/grok')
    runGrokCommand.mockImplementationOnce(async () => {
      authState.file = freshAuthJson()
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    })
    const result = await fetchGrokRateLimits()

    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(42)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' })
      })
    )
    expect(runGrokCommand).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/usr/bin/grok', args: ['sessions', 'list'] })
    )
  })

  it('refreshes successive tokens before expiry when the CLI only refreshes in its last five minutes', async () => {
    vi.useFakeTimers()
    const hourMs = 60 * 60 * 1000
    let expiresAtMs = Date.now() + hourMs
    let generation = 0
    const authJson = () =>
      JSON.stringify({
        'https://auth.x.ai::client': {
          key: `token-${generation}`,
          expires_at: new Date(expiresAtMs).toISOString()
        }
      })
    authState.file = authJson()
    resolveGrokCommand.mockResolvedValue('/usr/bin/grok')
    runGrokCommand.mockImplementation(async () => {
      // Grok CLI reuses a valid token until its five-minute early-invalidation buffer.
      if (expiresAtMs - Date.now() <= 5 * 60 * 1000) {
        generation += 1
        expiresAtMs = Date.now() + hourMs
        authState.file = authJson()
      }
      return { code: 0, timedOut: false }
    })
    fetchMock.mockImplementation(async () => jsonResponse(BILLING_RESPONSE))
    bindGrokTokenRefreshSchedule(() => {
      void fetchGrokRateLimits()
    })

    expect((await fetchGrokRateLimits()).status).toBe('ok')
    await vi.advanceTimersByTimeAsync(50 * 60 * 1000)
    expect(runGrokCommand).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(generation).toBe(1)
    expect(runGrokCommand).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' })
      })
    )

    await vi.advanceTimersByTimeAsync(55 * 60 * 1000)
    expect(generation).toBe(2)
    expect(runGrokCommand).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-2' })
      })
    )
  })

  it('does not run grok when the access token is still outside the refresh window', async () => {
    authState.file = freshAuthJson()
    fetchMock.mockResolvedValueOnce(jsonResponse(BILLING_RESPONSE))

    const result = await fetchGrokRateLimits()

    expect(result.status).toBe('ok')
    expect(resolveGrokCommand).not.toHaveBeenCalled()
  })
})
