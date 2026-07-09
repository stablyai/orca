import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const spawnMock = vi.hoisted(() => vi.fn())
const fsState = vi.hoisted<{ authJson: string | null }>(() => ({ authJson: null }))
const grokVersionMock = vi.hoisted(() => vi.fn(() => 'grok 0.2.91 (abc) [stable]\n'))
const hydrateShellPathMock = vi.hoisted(() => vi.fn())
const mergePathSegmentsMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFileSync: grokVersionMock
}))

vi.mock('node:fs', () => ({
  existsSync: () => fsState.authJson !== null,
  readFileSync: () => {
    if (fsState.authJson === null) {
      throw new Error('ENOENT')
    }
    return fsState.authJson
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: hydrateShellPathMock,
  mergePathSegments: mergePathSegmentsMock
}))

import { fetchGrokRateLimits, mapGrokBillingPayload } from './grok-fetcher'

type JsonRpcMessage = {
  id?: number
  method?: string
  params?: unknown
}

class FakeGrokProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((chunk: string, callback?: (error?: Error | null) => void) => {
      const message = JSON.parse(chunk.trim()) as JsonRpcMessage
      this.requests.push(message)
      if (message.method === 'initialize') {
        this.emitStdout({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            authMethods: [
              {
                id: 'cached_token',
                name: 'cached_token',
                description: 'Cached token from ~/.grok/auth.json'
              }
            ]
          }
        })
      }
      if (message.method === 'authenticate') {
        fsState.authJson = authJson('tok-after-auth')
        this.emitStdout({
          jsonrpc: '2.0',
          id: message.id,
          result: { _meta: { subscription_tier: 'X Premium+' } }
        })
      }
      callback?.(null)
      return true
    }),
    end: vi.fn()
  })
  readonly requests: JsonRpcMessage[] = []
  killedWith: NodeJS.Signals | null = null

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal ?? null
    return true
  }

  private emitStdout(value: unknown): void {
    setImmediate(() => {
      this.stdout.emit('data', `${JSON.stringify(value)}\n`)
    })
  }
}

function authJson(token: string): string {
  return JSON.stringify({
    'https://auth.x.ai::client-id': {
      key: token,
      auth_mode: 'oidc',
      expires_at: '2099-01-01T00:00:00Z'
    }
  })
}

function expiredAuthJson(token: string): string {
  return JSON.stringify({
    'https://auth.x.ai::client-id': {
      key: token,
      auth_mode: 'oidc',
      expires_at: '2000-01-01T00:00:00Z'
    }
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

const BILLING_RESPONSE = {
  config: {
    creditUsagePercent: 53,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-07-05T02:24:47.122004+00:00',
      end: '2026-07-12T02:24:47.122004+00:00'
    },
    productUsage: [
      { product: 'GrokBuild', usagePercent: 52 },
      { product: 'GrokChat', usagePercent: 1 }
    ],
    billingPeriodStart: '2026-07-05T02:24:47.122004+00:00',
    billingPeriodEnd: '2026-07-12T02:24:47.122004+00:00'
  }
}

describe('mapGrokBillingPayload', () => {
  it('uses the GrokBuild product usage as the weekly usage window', () => {
    const result = mapGrokBillingPayload(BILLING_RESPONSE, 123)

    expect(result).toMatchObject({
      provider: 'grok',
      status: 'ok',
      session: null,
      weekly: {
        usedPercent: 52,
        windowMinutes: 10080,
        resetsAt: new Date('2026-07-12T02:24:47.122004+00:00').getTime()
      },
      updatedAt: 123,
      error: null,
      usageMetadata: { source: 'cli' }
    })
  })

  it('falls back to total credit usage when product usage is unavailable', () => {
    const result = mapGrokBillingPayload(
      {
        config: {
          creditUsagePercent: 37,
          billingPeriodEnd: '2026-07-12T02:24:47.122004+00:00'
        }
      },
      456
    )

    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(37)
  })

  it('returns a parse error when the billing payload has no usable usage percentage', () => {
    const result = mapGrokBillingPayload({ config: {} }, 789)

    expect(result.provider).toBe('grok')
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })
})

describe('fetchGrokRateLimits', () => {
  let fakeProcess: FakeGrokProcess

  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    fsState.authJson = authJson('tok-before-auth')
    fakeProcess = new FakeGrokProcess()
    spawnMock.mockReturnValue(fakeProcess)
    netFetchMock.mockResolvedValue(jsonResponse(BILLING_RESPONSE))
    hydrateShellPathMock.mockResolvedValue({
      segments: ['/home/test/.grok/bin'],
      ok: true,
      failureReason: 'none'
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses a fresh cached token directly without spawning Grok ACP', async () => {
    const result = await fetchGrokRateLimits()

    expect(spawnMock).not.toHaveBeenCalled()
    expect(grokVersionMock).not.toHaveBeenCalled()
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tok-before-auth'
        })
      })
    )
    expect(netFetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-grok-client-version')
    expect(result.provider).toBe('grok')
    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(52)
  })

  it('authenticates through Grok ACP only after billing rejects the cached token', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse(BILLING_RESPONSE))

    const result = await fetchGrokRateLimits()

    expect(spawnMock).toHaveBeenCalledWith('grok', ['--no-auto-update', 'agent', 'stdio'], {
      stdio: ['pipe', 'pipe', 'ignore']
    })
    expect(fakeProcess.requests.map((request) => request.method)).toEqual([
      'initialize',
      'authenticate'
    ])
    expect(netFetchMock).toHaveBeenNthCalledWith(
      1,
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tok-before-auth'
        })
      })
    )
    expect(netFetchMock).toHaveBeenNthCalledWith(
      2,
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tok-after-auth'
        })
      })
    )
    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(52)
  })

  it('hydrates shell PATH before spawning Grok ACP for an expired cached token', async () => {
    fsState.authJson = expiredAuthJson('tok-expired')

    await fetchGrokRateLimits()

    expect(hydrateShellPathMock).toHaveBeenCalledTimes(1)
    expect(mergePathSegmentsMock).toHaveBeenCalledWith(['/home/test/.grok/bin'])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tok-after-auth'
        })
      })
    )
  })

  it('honors GROK_HOME and GROK_CLI_CHAT_PROXY_BASE_URL', async () => {
    vi.stubEnv('GROK_HOME', '/custom/grok-home')
    vi.stubEnv('GROK_CLI_CHAT_PROXY_BASE_URL', 'https://proxy.example.test/v1/')

    await fetchGrokRateLimits()

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://proxy.example.test/v1/billing?format=credits',
      expect.anything()
    )
  })

  it('returns unavailable without spawning when Grok is not signed in', async () => {
    fsState.authJson = null

    const result = await fetchGrokRateLimits()

    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(spawnMock).not.toHaveBeenCalled()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns unavailable when Grok is not installed', async () => {
    fsState.authJson = expiredAuthJson('tok-expired')
    const error = Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' })
    spawnMock.mockImplementationOnce(() => {
      const proc = new FakeGrokProcess()
      setImmediate(() => proc.emit('error', error))
      return proc
    })

    const result = await fetchGrokRateLimits()

    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('cli-unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns promptly when Grok ACP exits before authentication completes', async () => {
    fsState.authJson = expiredAuthJson('tok-expired')
    spawnMock.mockImplementationOnce(() => {
      const proc = new FakeGrokProcess()
      proc.stdin.write.mockImplementation((chunk: string) => {
        proc.requests.push(JSON.parse(chunk.trim()) as JsonRpcMessage)
        return true
      })
      setImmediate(() => proc.emit('close', 1))
      return proc
    })

    const result = await fetchGrokRateLimits()

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('cli-unavailable')
  })
})
