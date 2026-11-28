import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readKimchiUsageAuth } from './kimchi-auth'
import { fetchKimchiRateLimits } from './kimchi-fetcher'

const { httpFetch } = vi.hoisted(() => ({ httpFetch: vi.fn() }))
vi.mock('../../../network/http-client', () => ({
  getMainHttpClient: () => ({ fetch: httpFetch })
}))
vi.mock('../../../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: async () => {}
}))

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kimchi-auth-'))
  httpFetch.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

function writeConfig(value: Record<string, unknown>): void {
  const dir = join(home, '.config', 'kimchi')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(value))
}

it('uses the saved region for an environment key when the override is missing or invalid', async () => {
  writeConfig({ apiKey: 'saved-key', region: 'eu' })

  expect(
    await readKimchiUsageAuth({
      home,
      env: { KIMCHI_API_KEY: 'environment-key', KIMCHI_REGION: 'invalid' }
    })
  ).toMatchObject({
    status: 'ok',
    auth: {
      apiKey: 'environment-key',
      apiBaseUrl: 'https://api.eu.cast.ai',
      credentialSource: 'environment'
    }
  })
})

it('allows an environment-only login without a saved config file', async () => {
  expect(
    await readKimchiUsageAuth({
      home,
      env: { KIMCHI_API_KEY: 'environment-key', KIMCHI_REGION: 'eu' }
    })
  ).toMatchObject({
    status: 'ok',
    auth: { apiBaseUrl: 'https://api.eu.cast.ai', credentialSource: 'environment' }
  })
})

it('allows a complete public-region environment login when config is malformed', async () => {
  const dir = join(home, '.config', 'kimchi')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), '{"region":')

  expect(
    await readKimchiUsageAuth({
      home,
      env: { KIMCHI_API_KEY: 'environment-key', KIMCHI_REGION: 'eu' }
    })
  ).toMatchObject({
    status: 'ok',
    auth: { apiBaseUrl: 'https://api.eu.cast.ai', credentialSource: 'environment' }
  })
  expect(
    await readKimchiUsageAuth({ home, env: { KIMCHI_API_KEY: 'environment-key' } })
  ).toMatchObject({ status: 'error' })
})

it('reads the legacy snake_case config key', async () => {
  writeConfig({ api_key: 'legacy-key', region: 'us' })

  expect(await readKimchiUsageAuth({ home, env: {} })).toMatchObject({
    status: 'ok',
    auth: { apiKey: 'legacy-key', credentialSource: 'config' }
  })
})

it('changes provenance when the resolved API region changes', async () => {
  const readProvenance = async (): Promise<string> => {
    const result = await readKimchiUsageAuth({ home, env: {} })
    if (result.status !== 'ok') {
      throw new Error(`Expected Kimchi auth, got ${result.status}`)
    }
    return result.auth.authProvenance
  }

  writeConfig({ apiKey: 'saved-key', region: 'us' })
  const usProvenance = await readProvenance()
  expect(await readProvenance()).toBe(usProvenance)

  writeConfig({ apiKey: 'saved-key', region: 'eu' })
  expect(await readProvenance()).not.toBe(usProvenance)
})

it('classifies an interrupted response body as a network failure', async () => {
  vi.stubEnv('KIMCHI_API_KEY', '')
  vi.stubEnv('KIMCHI_REGION', '')
  writeConfig({ apiKey: 'saved-key', region: 'us' })
  httpFetch.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('body interrupted'))
        }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  )

  expect(await fetchKimchiRateLimits({ home })).toMatchObject({
    provider: 'kimchi',
    status: 'error',
    usageMetadata: { failureKind: 'network' }
  })
})

it('rejects self-hosted credentials without sending a request', async () => {
  vi.stubEnv('KIMCHI_API_KEY', '')
  vi.stubEnv('KIMCHI_REGION', '')
  writeConfig({ apiKey: 'self-hosted-key', region: 'self-hosted' })
  httpFetch.mockImplementation(async (url: string) => {
    const body = url.includes('api-keys:verify')
      ? { organizationId: 'test-org' }
      : {
          period: { startTime: '2026-11-01T00:00:00Z', endTime: '2026-12-01T00:00:00Z' },
          budgets: [{ scope: 'USER', budgetLimitUsd: '100', totalSpendUsd: '10' }]
        }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  })

  expect(await fetchKimchiRateLimits({ home })).toMatchObject({
    provider: 'kimchi',
    status: 'unavailable'
  })
  expect(httpFetch).not.toHaveBeenCalled()
})
