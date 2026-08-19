import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, ptySpawnMock, readFileMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  ptySpawnMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: childSpawnMock }))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
vi.mock('node-pty', () => ({ spawn: ptySpawnMock }))
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(async () => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'

function makeRpcChild(
  rateLimitResetCredits?: unknown,
  extraResult: Record<string, unknown> = {},
  rateLimits: Record<string, unknown> = {
    primary: { usedPercent: 22, windowDurationMins: 10_080 }
  }
) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
    exitCode: number | null
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  // Why: like the real app-server, the fake dies on stdin EOF or a signal —
  // the graceful shutdown path resolves only once the child reports exit.
  const exitNow = (): void => {
    child.exitCode = 0
    child.emit('exit', 0, null)
  }
  child.kill = vi.fn(() => {
    exitNow()
    return true
  })
  child.stdin = Object.assign(new EventEmitter(), {
    end: vi.fn(exitNow),
    write: vi.fn((line: string) => {
      const message = JSON.parse(line) as { id?: number; method?: string }
      if (message.method === 'initialize') {
        setTimeout(() => {
          child.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`)
          )
        }, 0)
      }
      if (message.method === 'account/rateLimits/read') {
        setTimeout(() => {
          child.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  rateLimits,
                  ...extraResult,
                  ...(rateLimitResetCredits !== undefined ? { rateLimitResetCredits } : {})
                }
              })}\n`
            )
          )
        }, 0)
      }
    })
  })
  return child
}

function usageResponse(rateLimitResetCredits?: unknown): Response {
  return {
    ok: true,
    json: async () => ({
      plan_type: 'pro',
      rate_limit: {
        primary_window: {
          used_percent: 23,
          limit_window_seconds: 7 * 24 * 60 * 60
        }
      },
      ...(rateLimitResetCredits !== undefined
        ? { rate_limit_reset_credits: rateLimitResetCredits }
        : {})
    })
  } as Response
}

function dedicatedCreditsResponse(): Response {
  return {
    ok: true,
    json: async () => ({
      available_count: 2,
      credits: [
        {
          status: 'available',
          expires_at: '2027-01-15T12:00:00Z',
          granted_at: '2027-01-08T12:00:00Z'
        }
      ]
    })
  } as Response
}

async function fetchWeeklyOnly(
  rateLimitResetCredits?: unknown,
  extraResult: Record<string, unknown> = {},
  rateLimits: Record<string, unknown> = {
    primary: { usedPercent: 22, windowDurationMins: 10_080 }
  }
) {
  childSpawnMock.mockReturnValue(makeRpcChild(rateLimitResetCredits, extraResult, rateLimits))
  const resultPromise = fetchCodexRateLimits()
  await vi.advanceTimersByTimeAsync(1)
  await vi.advanceTimersByTimeAsync(1)
  return resultPromise
}

describe('Codex backend session supplement credits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    readFileMock.mockResolvedValue(
      JSON.stringify({
        tokens: { access_token: 'access-token', account_id: 'account-id' }
      })
    )
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reuses complete zero-credit metadata from a weekly-only usage response', async () => {
    vi.mocked(fetch).mockResolvedValue(usageResponse({ available_count: 0 }))

    const result = await fetchWeeklyOnly()
    expect(result).toMatchObject({
      session: null,
      weekly: { usedPercent: 22, windowMinutes: 10_080 },
      rateLimitResetCredits: { availableCount: 0, nextExpiresAt: null }
    })
    expect(result.planType).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('maps a direct RPC individual limit precisely and skips the backend supplement', async () => {
    await expect(
      fetchWeeklyOnly(
        undefined,
        {
          planType: 'business',
          individualLimit: { limit: 3, used: 1, remainingPercent: 67, resetsAt: 1_785_542_400 }
        },
        {}
      )
    ).resolves.toMatchObject({
      monthly: {
        usedPercent: 33.33333333333333,
        windowMinutes: 43_200,
        resetsAt: 1_785_542_400_000
      },
      planType: 'business'
    })
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).not.toContain(
      'https://chatgpt.com/backend-api/wham/usage'
    )
  })

  it('keeps the monthly usage when the reset timestamp is an ISO string', async () => {
    await expect(
      fetchWeeklyOnly(
        undefined,
        {
          planType: 'business',
          individualLimit: {
            usedPercent: 65,
            resetsAt: '2026-04-01T00:00:00Z'
          }
        },
        {}
      )
    ).resolves.toMatchObject({
      monthly: {
        usedPercent: 65,
        resetsAt: Date.parse('2026-04-01T00:00:00Z')
      }
    })
  })

  it('falls back to remaining percent when direct usage is absent', async () => {
    await expect(
      fetchWeeklyOnly(
        undefined,
        {
          planType: 'business',
          individualLimit: { remainingPercent: 20 }
        },
        {}
      )
    ).resolves.toMatchObject({ monthly: { usedPercent: 80, windowMinutes: 43_200 } })
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).not.toContain(
      'https://chatgpt.com/backend-api/wham/usage'
    )
  })

  it('rejects a negative used amount even when a direct percentage is present', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({})
    } as Response)

    await expect(
      fetchWeeklyOnly(
        undefined,
        {
          planType: 'business',
          individualLimit: { used: -1, usedPercent: 20 }
        },
        {}
      )
    ).resolves.toMatchObject({ monthly: null })
  })

  it('clamps finite over-cap usage instead of discarding the monthly window', async () => {
    await expect(
      fetchWeeklyOnly(
        undefined,
        {
          planType: 'business',
          individualLimit: {
            limit: '3',
            used: '4',
            usedPercent: 105,
            remainingPercent: -5
          }
        },
        {}
      )
    ).resolves.toMatchObject({ monthly: { usedPercent: 100, windowMinutes: 43_200 } })
  })

  it('supplements an empty successful RPC result for an older CLI', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        plan_type: 'business',
        rate_limit: null,
        spend_control: {
          individual_limit: {
            source: 'account_user_spend_controls',
            limit: '11450',
            used: '4522.358407497406',
            used_percent: 39,
            remaining_percent: 61,
            reset_at: 1_785_542_400
          }
        }
      })
    } as Response)

    await expect(fetchWeeklyOnly(undefined, {}, {})).resolves.toMatchObject({
      session: null,
      weekly: null,
      monthly: {
        usedPercent: (4522.358407497406 / 11450) * 100,
        resetsAt: 1_785_542_400_000
      }
    })
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => url === 'https://chatgpt.com/backend-api/wham/usage')
    ).toHaveLength(1)
  })

  it('keeps the weekly-only session supplement when direct monthly data is also present', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 23, limit_window_seconds: 300 },
          secondary_window: { used_percent: 45, limit_window_seconds: 7 * 24 * 60 * 60 }
        }
      })
    } as Response)

    await expect(
      fetchWeeklyOnly(undefined, {
        planType: 'business',
        individualLimit: { limit: 3, used: 1, remainingPercent: 67, resetsAt: 1_785_542_400 }
      })
    ).resolves.toMatchObject({
      session: { usedPercent: 23, windowMinutes: 5 },
      weekly: { usedPercent: 45, windowMinutes: 10_080 },
      monthly: { usedPercent: 33.33333333333333, windowMinutes: 43_200 }
    })
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toContain(
      'https://chatgpt.com/backend-api/wham/usage'
    )
  })

  it('does not supplement a known non-Business empty RPC result', async () => {
    await expect(fetchWeeklyOnly(undefined, { planType: 'plus' }, {})).resolves.toMatchObject({
      session: null,
      weekly: null
    })
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).not.toContain(
      'https://chatgpt.com/backend-api/wham/usage'
    )
  })

  it('does not supplement an unavailable RPC result', async () => {
    const child = makeRpcChild()
    childSpawnMock.mockReturnValue(child)
    const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
    await vi.advanceTimersByTimeAsync(0)
    child.emit('error', Object.assign(new Error('Codex CLI not found'), { code: 'ENOENT' }))

    await expect(resultPromise).resolves.toMatchObject({ status: 'unavailable' })
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).not.toContain(
      'https://chatgpt.com/backend-api/wham/usage'
    )
  })

  it('does not retry a failed WSL backend-first request through the supplement', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('backend unavailable'))
    childSpawnMock.mockReturnValue(makeRpcChild({ availableCount: 0 }))
    const resultPromise = fetchCodexRateLimits({
      codexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex',
      allowPtyFallback: false
    })
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(resultPromise).resolves.toMatchObject({
      session: null,
      weekly: { usedPercent: 22, windowMinutes: 10_080 },
      status: 'ok'
    })
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => url === 'https://chatgpt.com/backend-api/wham/usage')
    ).toHaveLength(1)
  })

  it('uses PTY after an RPC error without retrying the WSL backend', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('backend unavailable'))
    const child = makeRpcChild()
    child.stdin.write.mockImplementation(() => {})
    childSpawnMock.mockReturnValue(child)

    let onDataHandler: ((data: string) => void) | undefined
    ptySpawnMock.mockReturnValue({
      onData: vi.fn((callback: (data: string) => void) => {
        onDataHandler = callback
        return { dispose: vi.fn() }
      }),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      kill: vi.fn()
    })

    const resultPromise = fetchCodexRateLimits({
      codexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex'
    })
    await vi.advanceTimersByTimeAsync(0)
    child.emit('close')
    await vi.advanceTimersByTimeAsync(0)

    expect(ptySpawnMock).toHaveBeenCalledOnce()
    onDataHandler?.('>')
    onDataHandler?.('Weekly limit: 12%\n')
    await vi.advanceTimersByTimeAsync(500)

    await expect(resultPromise).resolves.toMatchObject({
      weekly: { usedPercent: 12 },
      status: 'ok'
    })
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => url === 'https://chatgpt.com/backend-api/wham/usage')
    ).toHaveLength(1)
  })

  it.each([
    { name: 'null', credits: null },
    { name: 'invalid', credits: {} }
  ])('preserves complete RPC credits when usage metadata is $name', async ({ credits }) => {
    vi.mocked(fetch).mockResolvedValue(usageResponse(credits))

    await expect(
      fetchWeeklyOnly({
        availableCount: 1,
        nextExpiresAt: 1_800_000_000
      })
    ).resolves.toMatchObject({
      rateLimitResetCredits: {
        availableCount: 1,
        nextExpiresAt: 1_800_000_000_000
      }
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { name: 'absent', credits: undefined },
    { name: 'incomplete', credits: { available_count: 2 } }
  ])('uses the dedicated credits endpoint when usage metadata is $name', async ({ credits }) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(usageResponse(credits))
      .mockResolvedValueOnce(dedicatedCreditsResponse())

    await expect(fetchWeeklyOnly()).resolves.toMatchObject({
      rateLimitResetCredits: {
        availableCount: 2,
        nextExpiresAt: Date.parse('2027-01-15T12:00:00Z')
      }
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      'https://chatgpt.com/backend-api/wham/usage',
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
    ])
  })
})
