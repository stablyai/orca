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
  it('does not substitute a different account when the selected provider lacks a key', async () => {
    writeConfig({
      model: { main: 'unconfigured/GLM-5.3' },
      provider: { zai: { options: { apiKey: 'other-account', baseURL: 'https://api.z.ai/v1' } } }
    })

    const result = await fetchZcodeRateLimits({ configPath })

    expect(result.status).toBe('unavailable')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports an unusable plan credential instead of switching to the CLI config', async () => {
    writeConfig()
    vi.mocked(fetch).mockResolvedValue(new Response('{}'))

    const result = await fetchZcodeRateLimits({
      configPath,
      planCredential: { apiKey: 'bad\r\nkey', baseUrl: 'https://api.z.ai' }
    })

    expect(result.status).toBe('error')
    expect(result.error).toBe('The saved GLM Coding Plan API key is unusable')
    expect(fetch).not.toHaveBeenCalled()
    expect(result.usageMetadata?.credentialSource).toBeUndefined()
  })
})

describe('quota credential privacy', () => {
  it.each(['network', 'response'])('redacts a credential echoed by a %s error', async (kind) => {
    writeConfig()
    if (kind === 'network') {
      vi.mocked(fetch).mockRejectedValue(new Error('Rejected test-secret'))
    } else {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ success: false, msg: 'Rejected test-secret' }))
      )
    }
    const result = await fetchZcodeRateLimits({ configPath })
    expect(result.error).toBe('Rejected [redacted]')
    expect(JSON.stringify(result)).not.toContain('test-secret')
  })
})
