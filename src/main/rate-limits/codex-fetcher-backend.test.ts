import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, readFileMock, ptySpawnMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  readFileMock: vi.fn(),
  ptySpawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: childSpawnMock }))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('node-pty', () => ({ spawn: ptySpawnMock }))
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(async () => 'present')
}))

import { consumeCodexRateLimitResetCredit, fetchCodexRateLimits } from './codex-fetcher'

const authSnapshot = {
  status: 'present' as const,
  authJson: JSON.stringify({
    tokens: { access_token: 'access-token', account_id: 'account-id' }
  })
}

describe('Codex backend rate-limit requests', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses the official backend usage contract without spawning Codex', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          plan_type: 'plus',
          rate_limit: {
            primary_window: {
              used_percent: 12,
              limit_window_seconds: 3_600,
              reset_at: 1_800_000_000
            },
            secondary_window: {
              used_percent: 34,
              limit_window_seconds: 86_400,
              reset_at: 1_800_100_000
            }
          },
          rate_limit_reset_credits: { available_count: 1 }
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          available_count: 1,
          credits: [
            {
              status: 'available',
              expires_at: '2027-01-15T12:00:00Z',
              granted_at: '2027-01-08T12:00:00Z'
            }
          ]
        })
      } as Response)

    await expect(
      fetchCodexRateLimits({
        codexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\account\\home',
        authSnapshot
      })
    ).resolves.toMatchObject({
      session: { usedPercent: 12, windowMinutes: 60, resetsAt: 1_800_000_000_000 },
      weekly: { usedPercent: 34, windowMinutes: 1440, resetsAt: 1_800_100_000_000 },
      rateLimitResetCredits: {
        availableCount: 1,
        nextExpiresAt: Date.parse('2027-01-15T12:00:00Z')
      },
      planType: 'plus',
      status: 'ok'
    })

    expect(childSpawnMock).not.toHaveBeenCalled()
    expect(ptySpawnMock).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('classifies a sole seven-day backend primary window as weekly', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          plan_type: 'plus',
          rate_limit: {
            primary_window: {
              used_percent: 37,
              limit_window_seconds: 7 * 24 * 60 * 60,
              reset_at: 1_800_000_000
            },
            secondary_window: null
          }
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ available_count: 0, credits: [] })
      } as Response)

    await expect(
      fetchCodexRateLimits({
        codexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\account\\home',
        authSnapshot
      })
    ).resolves.toMatchObject({
      session: null,
      weekly: { usedPercent: 37, windowMinutes: 10_080, resetsAt: 1_800_000_000_000 },
      status: 'ok'
    })

    expect(childSpawnMock).not.toHaveBeenCalled()
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it('uses injected auth concurrently without reading credentials from disk', async () => {
    const codexHomePath = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex'
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 3_600 },
          secondary_window: { used_percent: 20, limit_window_seconds: 604_800 }
        },
        rate_limit_reset_credits: { available_count: 0 }
      })
    } as Response)

    await Promise.all([
      fetchCodexRateLimits({ codexHomePath, authSnapshot }),
      fetchCodexRateLimits({ codexHomePath, authSnapshot })
    ])

    expect(readFileMock).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(childSpawnMock).not.toHaveBeenCalled()
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it('applies the backend deadline to reset requests', async () => {
    const timeoutController = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timeoutController.signal)
    const deadlineError = new Error('backend deadline')
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )

    const result = consumeCodexRateLimitResetCredit({
      codexHomePath: '/managed/deadline-home',
      authSnapshot,
      idempotencyKey: 'redeem-timeout'
    })
    await vi.advanceTimersByTimeAsync(0)
    // Why: redeem is user-triggered, so it gets the longer redeem deadline.
    expect(timeout).toHaveBeenCalledWith(30_000)
    expect(readFileMock).not.toHaveBeenCalled()

    timeoutController.abort(deadlineError)

    await expect(result).rejects.toBe(deadlineError)
  })

  it('consumes a reset credit with the official payload and bounded request signal', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'already_redeemed' })
    } as Response)

    await expect(
      consumeCodexRateLimitResetCredit({
        codexHomePath: '/managed/codex-home',
        authSnapshot,
        idempotencyKey: 'redeem-123'
      })
    ).resolves.toBe('alreadyRedeemed')

    expect(fetch).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ redeem_request_id: 'redeem-123' }),
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'ChatGPT-Account-Id': 'account-id',
          'Content-Type': 'application/json'
        })
      })
    )
  })

  it('rejects corrupt auth JSON without issuing a reset request', async () => {
    await expect(
      consumeCodexRateLimitResetCredit({
        authSnapshot: { status: 'present', authJson: '{invalid' },
        idempotencyKey: 'corrupt-auth'
      })
    ).rejects.toThrow('Codex not signed in')

    expect(fetch).not.toHaveBeenCalled()
  })

  it('cancels the unread error-response body so bundled undici cannot crash on socket close', async () => {
    let cancelledBodies = 0
    vi.mocked(fetch).mockResolvedValue(
      cancelTrackingResponse(429, () => {
        cancelledBodies += 1
      })
    )

    await expect(
      consumeCodexRateLimitResetCredit({
        codexHomePath: '/managed/codex-home',
        authSnapshot,
        idempotencyKey: 'redeem-429'
      })
    ).rejects.toThrow('Codex reset failed: HTTP 429')
    expect(cancelledBodies).toBe(1)
  })
})
