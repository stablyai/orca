import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, readFileMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: childSpawnMock }))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(async () => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'

function parseRpcRequest(line: string): { id?: number; method?: string } {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null) {
    return {}
  }
  return {
    id: 'id' in parsed && typeof parsed.id === 'number' ? parsed.id : undefined,
    method: 'method' in parsed && typeof parsed.method === 'string' ? parsed.method : undefined
  }
}

// Like the real app-server, the fake dies on stdin EOF or a signal.
class FakeRpcChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  exitCode: number | null = null
  rateLimits: unknown = null
  readonly kill = vi.fn(() => {
    this.exitNow()
    return true
  })
  readonly stdin = Object.assign(new EventEmitter(), {
    end: vi.fn(() => this.exitNow()),
    write: vi.fn((line: string) => {
      const request = parseRpcRequest(line)
      if (request.method === 'initialize') {
        this.reply(request.id, {})
      }
      if (request.method === 'account/rateLimits/read') {
        this.reply(request.id, { rateLimits: this.rateLimits })
      }
    })
  })

  private reply(id: number | undefined, result: unknown): void {
    setTimeout(() => {
      this.stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`))
    }, 0)
  }

  private exitNow(): void {
    this.exitCode = 0
    this.emit('exit', 0, null)
  }
}

async function fetchWithRateLimits(rateLimits: unknown) {
  const child = new FakeRpcChild()
  child.rateLimits = rateLimits
  childSpawnMock.mockReturnValue(child)
  const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
  await vi.advanceTimersByTimeAsync(1)
  await vi.advanceTimersByTimeAsync(1)
  return resultPromise
}

describe('fetchCodexRateLimits credit balance', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    readFileMock.mockRejectedValue(new Error('no auth fixture'))
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('maps the RPC credits object into a Codex credit-count balance', async () => {
    const result = await fetchWithRateLimits({
      primary: { usedPercent: 20, windowDurationMins: 10079 },
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: '500' }
    })

    expect(result.extraUsage).toMatchObject({
      balance: 500,
      unit: 'credits',
      unlimited: false,
      enabled: true
    })
  })

  it('omits the Codex balance when the account has no credits', async () => {
    const result = await fetchWithRateLimits({
      primary: { usedPercent: 20, windowDurationMins: 10079 },
      credits: { hasCredits: false, unlimited: false, balance: '0' }
    })

    expect(result.extraUsage ?? null).toBeNull()
  })
})
