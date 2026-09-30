import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { net } from 'electron'
import {
  fetchCommandCodeRateLimits,
  validateCommandCodeSnapshot
} from './command-code-usage-fetcher'
import { readCommandCodeCredentials } from './command-code-auth'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, session: { defaultSession: {} } }))
vi.mock('../network/proxy-settings', () => ({ ensureElectronProxyFromEnvironment: vi.fn() }))

const RESET = 1_800_000_000_000
const credits = {
  credits: { monthlyCredits: 12, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    fiveHour: { used: 2, cap: 10, resetAt: RESET },
    weekly: { used: 30, cap: 40, resetAt: RESET + 1000 }
  }
}
let directory: string
let authPath: string

beforeEach(async () => {
  vi.resetAllMocks()
  vi.stubEnv('COMMAND_CODE_API_KEY', '')
  directory = await mkdtemp(join(tmpdir(), 'orca-command-code-'))
  authPath = join(directory, 'auth.json')
  await writeFile(authPath, JSON.stringify({ apiKey: 'test-secret-one', userId: 'private-user' }))
  vi.mocked(net.fetch).mockResolvedValue(Response.json(credits))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe('Command Code CLI usage', () => {
  it('uses the CLI login against the fixed official endpoint and maps rolling windows', async () => {
    const result = await fetchCommandCodeRateLimits({ authPath })
    expect(result).toMatchObject({
      provider: 'command-code',
      status: 'ok',
      session: { usedPercent: 20, windowMinutes: 300, resetsAt: RESET },
      weekly: { usedPercent: 75, windowMinutes: 10080 }
    })
    expect(result.monthly).toBeUndefined()
    expect(net.fetch).toHaveBeenCalledWith(
      'https://api.commandcode.ai/alpha/billing/credits',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-secret-one', Accept: 'application/json' },
        redirect: 'error',
        credentials: 'omit'
      })
    )
    expect(ensureElectronProxyFromEnvironment).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toMatch(/test-secret-one|private-user|auth.json/)
  })

  it.each(['switch', 'logout', 'environment override'])(
    'invalidates a completed snapshot after %s',
    async (change) => {
      const snapshot = await fetchCommandCodeRateLimits({ authPath })
      expect(await validateCommandCodeSnapshot(snapshot)).toBe(snapshot)
      if (change === 'switch') {
        await writeFile(authPath, JSON.stringify({ apiKey: 'test-secret-two' }))
      } else if (change === 'logout') {
        await rm(authPath)
      } else {
        vi.stubEnv('COMMAND_CODE_API_KEY', 'test-env-secret')
      }
      const result = await validateCommandCodeSnapshot(snapshot)
      expect(result).toMatchObject({ status: 'unavailable', session: null, weekly: null })
      expect(result.monthly).toBeUndefined()
      expect(JSON.stringify(result)).not.toMatch(/test-secret|test-env-secret/)
    }
  )

  it('uses an API key without a CLI login file', async () => {
    await rm(authPath)
    vi.stubEnv('COMMAND_CODE_API_KEY', 'test-env-secret')
    const result = await fetchCommandCodeRateLimits({ authPath })
    expect(result.status).toBe('ok')
    expect(result.usageMetadata?.credentialSource).toBe('COMMAND_CODE_API_KEY on this host')
    expect(vi.mocked(net.fetch).mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer test-env-secret'
    })
    expect(JSON.stringify(result)).not.toContain('test-env-secret')
  })

  it('prefers the environment key and never retries with the saved account on rejection', async () => {
    vi.stubEnv('COMMAND_CODE_API_KEY', 'test-env-secret')
    vi.mocked(net.fetch).mockResolvedValue(new Response('', { status: 401 }))
    expect((await fetchCommandCodeRateLimits({ authPath })).status).toBe('error')
    expect(net.fetch).toHaveBeenCalledOnce()
    expect(vi.mocked(net.fetch).mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer test-env-secret'
    })
  })

  it.each([' ', 'line\nbreak'])(
    'does not fall back to a saved login for a malformed environment key',
    async (key) => {
      vi.stubEnv('COMMAND_CODE_API_KEY', key)
      expect((await fetchCommandCodeRateLimits({ authPath })).status).toBe('unavailable')
      expect(net.fetch).not.toHaveBeenCalled()
    }
  )

  it('discards a response after the environment selects a different account', async () => {
    vi.stubEnv('COMMAND_CODE_API_KEY', 'test-env-secret')
    vi.mocked(net.fetch).mockImplementation(async () => {
      vi.stubEnv('COMMAND_CODE_API_KEY', 'test-env-new')
      return Response.json(credits)
    })
    expect((await fetchCommandCodeRateLimits({ authPath })).status).toBe('unavailable')
  })

  it.each([
    '{}',
    'null',
    '[]',
    '{invalid',
    '{"apiKey":""}',
    '{"apiKey":42}',
    '{"apiKey":"line\\nbreak"}'
  ])('does not request usage for invalid auth %s', async (raw) => {
    await writeFile(authPath, raw)
    expect((await fetchCommandCodeRateLimits({ authPath })).status).toBe('unavailable')
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('does not request usage for a missing or oversized auth file', async () => {
    await rm(authPath)
    expect(await readCommandCodeCredentials(authPath)).toBeNull()
    await writeFile(authPath, ' '.repeat(1_000_001))
    expect(await readCommandCodeCredentials(authPath)).toBeNull()
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('does not read a linked auth file', async () => {
    const link = join(directory, 'link.json')
    await symlink(authPath, link)
    expect(await readCommandCodeCredentials(link)).toBeNull()
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it.each([401, 403, 429, 500])(
    'classifies HTTP %s without exposing the response body',
    async (status) => {
      vi.mocked(net.fetch).mockResolvedValue(new Response('test-secret-one', { status }))
      const result = await fetchCommandCodeRateLimits({ authPath })
      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe(
        status === 429 ? 'rate-limited' : status === 500 ? 'server' : 'stale-token'
      )
      expect(JSON.stringify(result)).not.toContain('test-secret-one')
    }
  )

  it('does not expose a request error containing credentials', async () => {
    vi.mocked(net.fetch).mockRejectedValue(new Error('Bearer test-secret-one'))
    const result = await fetchCommandCodeRateLimits({ authPath })
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(JSON.stringify(result)).not.toContain('test-secret-one')
  })

  it('keeps cancellation attached to the request', async () => {
    const controller = new AbortController()
    controller.abort()
    await fetchCommandCodeRateLimits({ authPath, signal: controller.signal })
    expect(vi.mocked(net.fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('rejects HTML and an unexpected payload', async () => {
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(new Response('<html>login</html>'))
      .mockResolvedValueOnce(Response.json({ error: 'test-secret-one' }))
    for (let index = 0; index < 2; index++) {
      const result = await fetchCommandCodeRateLimits({ authPath })
      expect(result.usageMetadata?.failureKind).toBe('parse')
      expect(JSON.stringify(result)).not.toContain('test-secret-one')
    }
  })

  it('does not invent monthly quota for accounts without rolling windows', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      Response.json({ ...credits, windowLimits: { fiveHour: null, weekly: null } })
    )
    const result = await fetchCommandCodeRateLimits({ authPath })
    expect(result.status).toBe('unavailable')
    expect(result.monthly).toBeUndefined()
  })

  it('preserves zero usage with no reset', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      Response.json({
        windowLimits: { fiveHour: null, weekly: { used: 0, cap: 40, resetAt: 0 } }
      })
    )
    const result = await fetchCommandCodeRateLimits({ authPath })
    expect(result.session).toBeNull()
    expect(result.weekly).toMatchObject({ usedPercent: 0, resetsAt: null })
  })

  it.each([{ used: -1, cap: 10 }, { used: 1, cap: 0 }, { used: '1', cap: 10 }, { cap: 10 }])(
    'reports malformed quota as an error',
    async (fiveHour) => {
      vi.mocked(net.fetch).mockResolvedValue(
        Response.json({ windowLimits: { fiveHour, weekly: null } })
      )
      expect((await fetchCommandCodeRateLimits({ authPath })).usageMetadata?.failureKind).toBe(
        'parse'
      )
    }
  )

  it('enriches quota with a monthly estimate, ignoring purchased and free balances', async () => {
    const now = Date.now()
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(
        Response.json({
          ...credits,
          credits: { monthlyCredits: 4, purchasedCredits: 100, freeCredits: 50 }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            planId: 'individual-go',
            status: 'active',
            quantity: 1,
            orgId: null,
            currentPeriodStart: new Date(now - 86400000).toISOString(),
            currentPeriodEnd: new Date(now + 29 * 86400000).toISOString()
          }
        })
      )
    const result = await fetchCommandCodeRateLimits({ authPath })
    expect(result).toMatchObject({
      status: 'ok',
      planType: 'Go',
      monthly: { estimated: true, usedPercent: 60 }
    })
    expect(result.session?.usedPercent).toBe(20)
    expect(vi.mocked(net.fetch).mock.calls[1]?.[0]).toBe(
      'https://api.commandcode.ai/alpha/billing/subscriptions'
    )
  })

  it('keeps measured windows if the subscription request fails', async () => {
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(Response.json(credits))
      .mockRejectedValueOnce(new Error('test-secret-one'))
    const result = await fetchCommandCodeRateLimits({ authPath })
    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(20)
    expect(result.monthly).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('test-secret-one')
  })

  it('rechecks the selected key after subscription enrichment', async () => {
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(Response.json(credits))
      .mockImplementationOnce(async () => {
        await rm(authPath)
        return Response.json({ success: true, data: null })
      })
    expect((await fetchCommandCodeRateLimits({ authPath })).status).toBe('unavailable')
  })

  it.each(['switch', 'logout'])('discards an in-flight snapshot after %s', async (action) => {
    vi.mocked(net.fetch).mockImplementation(async () => {
      await (action === 'switch'
        ? writeFile(authPath, JSON.stringify({ apiKey: 'test-secret-two' }))
        : rm(authPath))
      return Response.json(credits)
    })
    const result = await fetchCommandCodeRateLimits({ authPath })
    expect(result.status).toBe('unavailable')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })
})
