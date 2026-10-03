import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, readFileMock, resolveCodexCommandMock, isBackfillPendingMock } =
  vi.hoisted(() => ({
    childSpawnMock: vi.fn(),
    readFileMock: vi.fn(),
    resolveCodexCommandMock: vi.fn(),
    isBackfillPendingMock: vi.fn(() => false)
  }))

vi.mock('node:child_process', () => ({
  spawn: childSpawnMock
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: vi.fn()
}))

vi.mock('../codex/codex-state-db', () => ({
  isCodexStateDbBackfillPending: isBackfillPendingMock
}))

vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn(() => Promise.resolve(null))
}))

vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'

function makeRpcChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
    exitCode: number | null
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const exitNow = (): void => {
    child.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  }
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(exitNow) })
  child.exitCode = null
  child.kill = vi.fn(() => {
    exitNow()
    return true
  })
  return child
}

function respondWithResetCredits(rpcChild: ReturnType<typeof makeRpcChild>, credits: unknown): void {
  rpcChild.stdin.write.mockImplementation((line: string) => {
    const msg = JSON.parse(line) as { id?: number; method?: string }
    if (msg.method === 'initialize') {
      setTimeout(() => {
        rpcChild.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
        )
      }, 0)
    }
    if (msg.method === 'account/rateLimits/read') {
      setTimeout(() => {
        rpcChild.stdout.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                rateLimits: { primary: { usedPercent: 5 } },
                rateLimitResetCredits: credits
              }
            })}\n`
          )
        )
      }, 0)
    }
  })
}

async function fetchWithMocks(credits: unknown): Promise<void> {
  const rpcChild = makeRpcChild()
  childSpawnMock.mockReturnValue(rpcChild)
  respondWithResetCredits(rpcChild, credits)
}

describe('fetchCodexRateLimits reset-credit supplement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
    readFileMock.mockResolvedValue(
      JSON.stringify({ tokens: { access_token: 'token', account_id: 'account-id' } })
    )
    isBackfillPendingMock.mockReturnValue(false)
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not let a backend 0 clobber a reset-credit count from the app-server', async () => {
    // Regression test for #22781: the app-server reports a count without expiry details
    // (its own detailed fetch failed), the backend supplement returns 0, and the panel
    // must keep showing the app-server count — a fallback fills gaps, never overwrites.
    await fetchWithMocks({ availableCount: 2, credits: null })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ available_count: 0, credits: [] })
    } as Response)

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await resultPromise

    expect(fetch).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      expect.anything()
    )
    expect(result.rateLimitResetCredits?.availableCount).toBe(2)
  })

  it('verifies an unconfirmed app-server 0 against the backend', async () => {
    // Regression test for #22781: the app-server falls back to a possibly-stale usage
    // count when its detailed fetch fails, so a bare 0 without confirming details must
    // be re-checked rather than trusted.
    await fetchWithMocks({ availableCount: 0, credits: null })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ available_count: 2, credits: [] })
    } as Response)

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await resultPromise

    expect(fetch).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      expect.anything()
    )
    expect(result.rateLimitResetCredits?.availableCount).toBe(2)
  })

  it('backfills a missing reset expiry from the backend', async () => {
    // Regression test for #22781: the reported symptom is a blank reset value — the
    // app-server count arrives without an expiry, and the merge must fill nextExpiresAt
    // from the backend's credit details.
    await fetchWithMocks({ availableCount: 2, credits: null })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        available_count: 2,
        credits: [{ status: 'available', expires_at: 1_759_000_000, granted_at: null }]
      })
    } as Response)

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await resultPromise

    expect(result.rateLimitResetCredits?.availableCount).toBe(2)
    expect(result.rateLimitResetCredits?.nextExpiresAt).toBe(1_759_000_000_000)
    expect(result.rateLimitResetCredits?.credits).toHaveLength(1)
  })

  it('does not supplement a zero count confirmed by empty credit details', async () => {
    // A 0 with empty details is a confirmed zero per the app-server protocol — no backend call.
    await fetchWithMocks({ availableCount: 0, credits: [] })

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await resultPromise

    expect(result.rateLimitResetCredits?.availableCount).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('re-verifies a zero that has an expiry but no credit details', async () => {
    // CodeRabbit follow-up on #22781: only an explicitly empty details list confirms a
    // zero — a zero with an expiry but no details is untrusted, like a bare zero, and
    // must be re-checked against the dedicated endpoint.
    await fetchWithMocks({ availableCount: 0, nextExpiresAt: 1_800_000_000, credits: null })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ available_count: 0, credits: [] })
    } as Response)

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await resultPromise

    expect(fetch).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      expect.anything()
    )
    expect(result.rateLimitResetCredits?.availableCount).toBe(0)
    expect(result.rateLimitResetCredits?.credits).toEqual([])
  })
})
