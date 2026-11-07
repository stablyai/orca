import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchZcodeRateLimits } from './zcode-usage-fetcher'
import type { ZcodeCredentialHost } from '../zcode/zcode-v2-plan-credentials'

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

const START_PLAN_SECRET = 'synthetic-start-plan-secret'
const START_PLAN_DEVICE_MID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const START_PLAN_JWT = 'start-plan-jwt-header.payload.signature'

function encryptZcodeSecret(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(
    'aes-256-gcm',
    createHash('sha256').update(START_PLAN_SECRET).digest(),
    iv
  )
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
}

function writeStartPlanStore(): ZcodeCredentialHost {
  const home = join(dir, 'home')
  mkdirSync(join(home, '.zcode', 'v2'), { recursive: true })
  writeFileSync(
    join(home, '.zcode', 'v2', 'credentials.json'),
    JSON.stringify({ zcodejwttoken: encryptZcodeSecret(START_PLAN_JWT) })
  )
  writeFileSync(
    join(home, '.zcode', 'v2', 'telemetry-state.json'),
    JSON.stringify({ deviceMid: START_PLAN_DEVICE_MID })
  )
  return {
    home,
    platform: 'linux',
    username: 'synthetic-user',
    env: { ZCODE_CREDENTIAL_SECRET: START_PLAN_SECRET }
  }
}

function startPlanBalanceResponse(): string {
  return JSON.stringify({
    code: 0,
    msg: '',
    data: {
      server_time: 1_794_040_689,
      plans: [
        {
          plan_id: 'zcode-v3-start-plan-1106-wk',
          name: 'ZCODE WEEKEND BUILD',
          status: 'active',
          priority: 101
        }
      ],
      balances: [
        {
          bucket_id: 'bucket_2118953275106230272',
          plan_id: 'zcode-v3-start-plan-1106-wk',
          show_name: 'GLM-5.3-Flash',
          meter: 'model_usage',
          unit_type: 'token',
          capabilities: ['model:glm-5.3-flash'],
          priority: 101,
          total_units: 500_000_000,
          used_units: 4_874_595,
          remaining_units: 495_125_405,
          available_units: 495_125_405,
          period_start: 1_793_971_778,
          period_end: 1_794_186_000,
          expires_at: 1_794_186_000
        }
      ]
    }
  })
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

  it('falls back to the Start Plan session when no Coding Plan credential exists', async () => {
    const host = writeStartPlanStore()
    vi.mocked(fetch).mockResolvedValue(new Response(startPlanBalanceResponse()))

    const result = await fetchZcodeRateLimits({ credentialHost: host })

    expect(result.status).toBe('ok')
    expect(result.planType).toBe('ZCODE WEEKEND BUILD')
    expect(result.buckets?.[0]).toEqual({
      name: 'GLM-5.3-Flash',
      usedPercent: expect.any(Number),
      windowMinutes: 3570,
      resetsAt: 1_794_186_000_000,
      resetDescription: null
    })
    expect(result.buckets?.[0]?.usedPercent).toBeCloseTo(0.974919, 5)
    expect(result.usageMetadata?.credentialSource).toBe('zcode-start-plan')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toBe(
      'https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.17.2'
    )
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${START_PLAN_JWT}`)
    expect(new Headers(init?.headers).get('User-Agent')).toBe('ZCode/3.17.2')
    expect(new Headers(init?.headers).get('X-ZCode-App-Version')).toBe('3.17.2')
    expect(new Headers(init?.headers).get('X-Device-Mid')).toBe(START_PLAN_DEVICE_MID)
    expect(JSON.stringify(result)).not.toContain(START_PLAN_JWT)
  })

  it('keeps the Coding Plan result when no Start Plan session exists', async () => {
    const host: ZcodeCredentialHost = {
      home: join(dir, 'empty-home'),
      platform: 'linux',
      username: 'synthetic-user',
      env: {}
    }

    const result = await fetchZcodeRateLimits({ credentialHost: host })

    expect(result.status).toBe('unavailable')
    expect(result.error).toBe('ZCode Coding Plan credentials are not configured')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('redacts a JWT echoed by a Start Plan balance rejection', async () => {
    const host = writeStartPlanStore()
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ code: 3001, msg: `Rejected ${START_PLAN_JWT}` }))
    )

    const result = await fetchZcodeRateLimits({ credentialHost: host })

    expect(result.status).toBe('error')
    expect(result.error).toBe('Rejected [redacted]')
    expect(result.usageMetadata?.failureKind).toBe('parse')
    expect(JSON.stringify(result)).not.toContain(START_PLAN_JWT)
  })

  it('does not fall back to the Start Plan session when a plan key is saved', async () => {
    writeStartPlanStore()
    vi.mocked(fetch).mockResolvedValue(new Response('denied', { status: 401 }))

    const result = await fetchZcodeRateLimits({
      planCredential: { apiKey: 'orca-saved-key', baseUrl: 'https://api.z.ai' }
    })

    expect(result.status).toBe('error')
    expect(result.error).toBe('ZCode quota request failed (401)')
    expect(result.usageMetadata?.credentialSource).toBe('orca-plan')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(
      'https://api.z.ai/api/monitor/usage/quota/limit'
    )
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
