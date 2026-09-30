import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchZcodeRateLimits } from './zcode-usage-fetcher'

let dir: string
let configPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-zcode-usage-'))
  configPath = join(dir, 'config.json')
  vi.stubGlobal('fetch', vi.fn())
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-12T06:00:00.000Z'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function writeConfig(overrides: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    configPath,
    JSON.stringify({
      model: { main: 'bigmodel-coding-plan/GLM-5.2' },
      provider: {
        other: { options: { apiKey: 'ignored', baseURL: 'https://example.com/v1' } },
        'bigmodel-coding-plan': {
          options: {
            apiKey: 'test-secret',
            baseURL: 'https://open.bigmodel.cn/api/anthropic'
          }
        }
      },
      ...overrides
    })
  )
}

describe('fetchZcodeRateLimits', () => {
  it('returns unavailable without a supported Coding Plan credential', async () => {
    writeFileSync(configPath, JSON.stringify({ provider: {} }))

    const result = await fetchZcodeRateLimits({ configPath })

    expect(result).toMatchObject({ provider: 'zcode', status: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not infer an account from the only configured provider without a selected model', async () => {
    writeConfig({
      model: {},
      provider: {
        zai: { options: { apiKey: 'sole-account', baseURL: 'https://api.z.ai/v1' } }
      }
    })

    const result = await fetchZcodeRateLimits({ configPath })

    expect(result.status).toBe('unavailable')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('queries the matching quota endpoint and maps rolling, weekly, and MCP limits', async () => {
    writeConfig()
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            level: 'max',
            limits: [
              {
                type: 'TIME_LIMIT',
                unit: 5,
                number: 1,
                percentage: 3,
                nextResetTime: 1_787_000_000_000
              },
              {
                type: 'TOKENS_LIMIT',
                unit: 6,
                number: 1,
                percentage: 44,
                nextResetTime: 1_786_600_000_000
              },
              {
                type: 'TOKENS_LIMIT',
                unit: 3,
                number: 5,
                percentage: 12,
                nextResetTime: 1_786_500_000_000
              }
            ]
          }
        })
      )
    )

    const result = await fetchZcodeRateLimits({ configPath })

    expect(fetch).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'test-secret' })
      })
    )
    expect(result).toMatchObject({ provider: 'zcode', status: 'ok', planType: 'max' })
    expect(result.session).toEqual({
      usedPercent: 12,
      windowMinutes: 300,
      resetsAt: 1_786_500_000_000,
      resetDescription: null
    })
    expect(result.weekly?.usedPercent).toBe(44)
    expect(result.monthly?.usedPercent).toBe(3)
  })

  it('uses CREDIT_LIMIT counts when the reported percentage is stale', async () => {
    writeConfig()
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          code: 200,
          data: {
            limits: [
              {
                type: 'CREDIT_LIMIT',
                unit: 3,
                number: 5,
                usage: 2_000,
                currentValue: 500,
                remaining: 1_500,
                percentage: 1
              },
              {
                type: 'CREDIT_LIMIT',
                unit: 6,
                number: 1,
                usage: 10_000,
                remaining: 8_000,
                percentage: 0
              }
            ]
          }
        })
      )
    )

    const result = await fetchZcodeRateLimits({ configPath })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(25)
    expect(result.weekly?.usedPercent).toBe(20)
    expect(result.monthly).toBeNull()
  })

  it('drops an implausible five-hour reset without discarding the quota value', async () => {
    writeConfig()
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            limits: [
              {
                type: 'CREDIT_LIMIT',
                unit: 3,
                number: 5,
                percentage: 25,
                nextResetTime: Date.now() + 10 * 60 * 60_000
              }
            ]
          }
        })
      )
    )

    const result = await fetchZcodeRateLimits({ configPath })

    expect(result.session?.usedPercent).toBe(25)
    expect(result.session?.resetsAt).toBeNull()
  })

  it('selects the legacy string model provider when several accounts are configured', async () => {
    writeConfig({
      model: 'zai/GLM-5.3',
      provider: {
        zai: { options: { apiKey: 'selected-key', baseURL: 'https://api.z.ai/v1' } },
        bigmodel: { options: { apiKey: 'other-key', baseURL: 'https://open.bigmodel.cn/v1' } }
      }
    })
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 20 }] }
        })
      )
    )

    const result = await fetchZcodeRateLimits({ configPath })

    expect(result.status).toBe('ok')
    expect(fetch).toHaveBeenCalledWith(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'selected-key' })
      })
    )
  })

  it('does not substitute a different account when the selected provider lacks a key', async () => {
    writeConfig({
      model: { main: 'unconfigured/GLM-5.3' },
      provider: { zai: { options: { apiKey: 'other-account', baseURL: 'https://api.z.ai/v1' } } }
    })

    const result = await fetchZcodeRateLimits({ configPath })

    expect(result.status).toBe('unavailable')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a nonstandard HTTPS port before sending the key', async () => {
    writeConfig({
      provider: { zai: { options: { apiKey: 'secret', baseURL: 'https://api.z.ai:4444/v1' } } }
    })

    const result = await fetchZcodeRateLimits({ configPath })

    expect(result.status).toBe('unavailable')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('supports the Z.AI endpoint without exposing credentials in errors', async () => {
    writeConfig({
      model: { main: 'zai/GLM-5.2' },
      provider: {
        zai: { options: { apiKey: 'never-log-me', baseURL: 'https://api.z.ai/api/anthropic' } }
      }
    })
    vi.mocked(fetch).mockResolvedValue(new Response('denied', { status: 401 }))

    const result = await fetchZcodeRateLimits({ configPath })

    expect(fetch).toHaveBeenCalledWith(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      expect.any(Object)
    )
    expect(result.status).toBe('error')
    expect(result.error).toBe('ZCode quota request failed (401)')
    expect(JSON.stringify(result)).not.toContain('never-log-me')
  })

  it('changes the non-secret account identity when the selected key changes', async () => {
    writeConfig()
    vi.mocked(fetch).mockResolvedValue(new Response('denied', { status: 401 }))

    const first = await fetchZcodeRateLimits({ configPath })
    writeConfig({
      provider: {
        'bigmodel-coding-plan': {
          options: { apiKey: 'new-key', baseURL: 'https://open.bigmodel.cn/api/anthropic' }
        }
      }
    })
    const second = await fetchZcodeRateLimits({ configPath })

    expect(first.usageMetadata?.authProvenance).toMatch(/^[a-f0-9]{64}$/)
    expect(second.usageMetadata?.authProvenance).not.toBe(first.usageMetadata?.authProvenance)
    expect(JSON.stringify(first)).not.toContain('test-secret')
    expect(JSON.stringify(second)).not.toContain('new-key')
  })

  it('rejects malformed successful responses', async () => {
    writeConfig()
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} })))

    const result = await fetchZcodeRateLimits({ configPath })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })
})
