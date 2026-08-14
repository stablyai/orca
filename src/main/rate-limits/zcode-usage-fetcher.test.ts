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

  it('queries the matching quota endpoint and maps rolling, weekly, and MCP limits', async () => {
    writeConfig()
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            level: 'max',
            limits: [
              { type: 'TIME_LIMIT', percentage: 3, nextResetTime: 1_787_000_000_000 },
              { type: 'TOKENS_LIMIT', percentage: 44, nextResetTime: 1_786_600_000_000 },
              { type: 'TOKENS_LIMIT', percentage: 12, nextResetTime: 1_786_500_000_000 }
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

  it('rejects malformed successful responses', async () => {
    writeConfig()
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} })))

    const result = await fetchZcodeRateLimits({ configPath })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })
})
