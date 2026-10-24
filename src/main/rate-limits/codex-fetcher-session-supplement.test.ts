import type * as FsPromisesModule from 'node:fs/promises'
import type * as ChildProcessModule from 'node:child_process'
import type * as ProcessHostModule from '@orca/process-host'
import type * as ProviderLedgerModule from '../provider-process/provider-process-ledger'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, readFileMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  readFileMock: vi.fn()
}))

// The probe's child runs in-process here; the worker transport has its own suite.
vi.mock(
  '../worker-thread-child-process/worker-thread-child-process',
  () =>
    import('../worker-thread-child-process/worker-thread-child-process-in-process.test-fixtures')
)
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcessModule>()),
  spawn: childSpawnMock
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FsPromisesModule>()),
  readFile: readFileMock
}))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(async () => 'present')
}))

// The recovery's supervised stop imports the process-table reader, which needs the real execFile.
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn()
}))

import { fetchCodexRateLimits } from './codex-fetcher'

function makeRpcChild(rateLimitResetCredits?: unknown) {
  type RpcChild = EventEmitter & {
    pid: number
    stdout: PassThrough
    stderr: PassThrough
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
    exitCode: number | null
  }
  // Why: like the real app-server, the fake dies on stdin EOF or a signal —
  // the graceful shutdown path resolves only once the child reports exit.
  const exitNow = (): void => {
    child.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  }
  const kill = vi.fn(() => {
    exitNow()
    return true
  })
  const stdin = Object.assign(new EventEmitter(), {
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
                  rateLimits: {
                    primary: { usedPercent: 22, windowDurationMins: 10_080 }
                  },
                  ...(rateLimitResetCredits !== undefined ? { rateLimitResetCredits } : {})
                }
              })}\n`
            )
          )
        }, 0)
      }
    })
  })
  const child: RpcChild = Object.assign(new EventEmitter(), {
    pid: 9_999_999,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin,
    kill,
    exitCode: null
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

async function fetchWeeklyOnly(rateLimitResetCredits?: unknown) {
  const child = makeRpcChild(rateLimitResetCredits)
  childSpawnMock.mockReturnValue(child)
  const resultPromise = fetchCodexRateLimits()
  await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalled(), { interval: 0 })
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

    await expect(fetchWeeklyOnly()).resolves.toMatchObject({
      session: null,
      weekly: { usedPercent: 22, windowMinutes: 10_080 },
      rateLimitResetCredits: { availableCount: 0, nextExpiresAt: null }
    })
    expect(fetch).toHaveBeenCalledTimes(1)
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

vi.mock('@orca/process-host', async (original) => ({
  ...(await original<typeof ProcessHostModule>()),
  spawnProcess: (spec: ProcessSpec) => childSpawnMock(spec.program, spec.args ?? [], spec)
}))

vi.mock('../provider-process/provider-process-ledger', async (original) => ({
  ...(await original<typeof ProviderLedgerModule>()),
  recordProviderLaunch: () => ({
    capture: async () => {},
    retire: async () => {},
    members: () => []
  })
}))
