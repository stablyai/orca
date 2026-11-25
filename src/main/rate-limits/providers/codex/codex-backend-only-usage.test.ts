import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { httpFetch, spawn } = vi.hoisted(() => ({ httpFetch: vi.fn(), spawn: vi.fn() }))
vi.mock('../../../network/http-client', () => ({ getMainHttpClient: () => ({ fetch: httpFetch }) }))
vi.mock('../../../worker-thread-child-process/worker-thread-child-process', () => ({
  spawnProcessOnWorkerThread: spawn
}))

import { fetchCodexRateLimits } from './codex-fetcher'

const homes: string[] = []
afterAll(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })))

function homeWithAuth(contents: string): string {
  const home = mkdtempSync(join(tmpdir(), 'codex-backend-only-'))
  homes.push(home)
  writeFileSync(join(home, 'auth.json'), contents)
  return home
}

function chatgptAuth(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return JSON.stringify({ tokens: { access_token: `e30.${payload}.sig`, account_id: 'acct' } })
}

const NOW_SECONDS = 1_800_000_000

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_SECONDS * 1000)
  spawn.mockReset()
  spawn.mockImplementation(() => {
    throw new Error('backend-only reads must not start codex app-server')
  })
  httpFetch.mockReset()
})

describe('backend-only Codex usage (unselected System default)', () => {
  it('reads usage over HTTP without starting app-server', async () => {
    httpFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: { primary_window: { used_percent: 37, limit_window_seconds: 18_000 } },
          rate_limit_reset_credits: { available_count: 0 }
        })
      )
    )
    const result = await fetchCodexRateLimits({
      codexHomePath: homeWithAuth(chatgptAuth(NOW_SECONDS + 3600)),
      backendUsageOnly: true
    })
    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(37)
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    ['an expired access token', chatgptAuth(NOW_SECONDS - 60), 0],
    ['a rejected access token', chatgptAuth(NOW_SECONDS + 3600), 1]
  ])('waits for Codex to renew %s instead of reporting a sign-out', async (_, auth, requests) => {
    httpFetch.mockResolvedValue(new Response('', { status: 401 }))
    const result = await fetchCodexRateLimits({
      codexHomePath: homeWithAuth(auth),
      backendUsageOnly: true
    })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('delegated-refresh-required')
    expect(httpFetch).toHaveBeenCalledTimes(requests)
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    ['an API-key login', JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' })],
    ['an unparseable auth.json', '{not json']
  ])('reports %s as usage unavailable', async (_, auth) => {
    const result = await fetchCodexRateLimits({
      codexHomePath: homeWithAuth(auth),
      backendUsageOnly: true
    })
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(httpFetch).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})
