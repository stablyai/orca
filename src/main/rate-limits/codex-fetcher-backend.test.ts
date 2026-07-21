import { join } from 'node:path'
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
    readFileMock.mockResolvedValue(
      JSON.stringify({
        tokens: { access_token: 'access-token', account_id: 'account-id' }
      })
    )
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
        codexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\account\\home'
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

  it('aborts callers while sharing one stalled backend auth read', async () => {
    let resolveRead!: (content: string) => void
    readFileMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        })
    )
    const firstController = new AbortController()
    const secondController = new AbortController()
    const codexHomePath = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex'

    const first = fetchCodexRateLimits({ codexHomePath, signal: firstController.signal })
    const second = fetchCodexRateLimits({ codexHomePath, signal: secondController.signal })
    await vi.advanceTimersByTimeAsync(0)
    expect(readFileMock).toHaveBeenCalledTimes(1)
    expect(readFileMock).toHaveBeenCalledWith(expect.stringContaining('auth.json'), 'utf8')

    firstController.abort()
    secondController.abort()

    await expect(first).resolves.toMatchObject({
      provider: 'codex',
      status: 'error',
      error: 'Rate-limit fetch aborted'
    })
    await expect(second).resolves.toMatchObject({
      provider: 'codex',
      status: 'error',
      error: 'Rate-limit fetch aborted'
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(childSpawnMock).not.toHaveBeenCalled()
    expect(ptySpawnMock).not.toHaveBeenCalled()
    resolveRead('{}')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('applies the backend deadline while auth reading is still pending', async () => {
    let resolveRead!: (content: string) => void
    readFileMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        })
    )
    const timeoutController = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timeoutController.signal)
    const deadlineError = new Error('backend deadline')

    const result = consumeCodexRateLimitResetCredit({
      codexHomePath: '/managed/deadline-home',
      idempotencyKey: 'redeem-timeout'
    })
    await vi.advanceTimersByTimeAsync(0)
    // Why: redeem is user-triggered, so it gets the longer redeem deadline.
    expect(timeout).toHaveBeenCalledWith(30_000)
    expect(readFileMock).toHaveBeenCalledWith(join('/managed/deadline-home', 'auth.json'), 'utf8')

    timeoutController.abort(deadlineError)

    await expect(result).rejects.toBe(deadlineError)
    resolveRead('{}')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('consumes a reset credit with the official payload and bounded request signal', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        tokens: { access_token: 'access-token', account_id: 'account-id' }
      })
    )
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'already_redeemed' })
    } as Response)

    await expect(
      consumeCodexRateLimitResetCredit({
        codexHomePath: '/managed/codex-home',
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

  it('cancels the unread error-response body so bundled undici cannot crash on socket close', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        tokens: { access_token: 'access-token', account_id: 'account-id' }
      })
    )
    let cancelledBodies = 0
    vi.mocked(fetch).mockResolvedValue(
      cancelTrackingResponse(429, () => {
        cancelledBodies += 1
      })
    )

    await expect(
      consumeCodexRateLimitResetCredit({
        codexHomePath: '/managed/codex-home',
        idempotencyKey: 'redeem-429'
      })
    ).rejects.toThrow('Codex reset failed: HTTP 429')
    expect(cancelledBodies).toBe(1)
  })
})
