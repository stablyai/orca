import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../macos-keychain/generic-password', () => ({
  execSecurityCommand: vi.fn(),
  isKeychainNotFoundError: (error: unknown) => (error as { code?: unknown } | null)?.code === 44
}))

import { execSecurityCommand } from '../macos-keychain/generic-password'
import {
  fetchCopilotRateLimits,
  getGithubCopilotConfigDir,
  resetCopilotKeychainDenialForTests,
  toCopilotWindow
} from './copilot-usage-fetcher'

let dir: string
const RESET = '2026-11-01T00:00:00.000Z'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function writeApps(entries: Record<string, unknown>): void {
  writeFileSync(join(dir, 'apps.json'), JSON.stringify(entries))
}

const quotaBody = {
  copilot_plan: 'enterprise',
  quota_reset_date: RESET,
  quota_snapshots: {
    chat: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100 },
    premium_interactions: {
      entitlement: 1000,
      remaining: 640,
      percent_remaining: 64,
      unlimited: false
    }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-copilot-usage-'))
  vi.stubGlobal('fetch', vi.fn())
  vi.mocked(execSecurityCommand).mockReset()
  resetCopilotKeychainDenialForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('getGithubCopilotConfigDir', () => {
  it('honors XDG_CONFIG_HOME, falls back to ~/.config, and uses LOCALAPPDATA on Windows', () => {
    expect(getGithubCopilotConfigDir({ XDG_CONFIG_HOME: '/x' }, 'linux', '/h')).toBe(
      join('/x', 'github-copilot')
    )
    expect(getGithubCopilotConfigDir({}, 'darwin', '/h')).toBe(
      join('/h', '.config', 'github-copilot')
    )
    expect(getGithubCopilotConfigDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', '/h')).toBe(
      join('C:\\L', 'github-copilot')
    )
  })
})

describe('toCopilotWindow', () => {
  it('derives used percent from entitlement/remaining', () => {
    expect(toCopilotWindow({ entitlement: 50, remaining: 40 }, 1)).toMatchObject({
      usedPercent: 20,
      resetsAt: 1
    })
  })

  it('falls back to percent_remaining and clamps', () => {
    expect(toCopilotWindow({ percent_remaining: -5 }, null)?.usedPercent).toBe(100)
  })

  it('returns null for unlimited buckets', () => {
    expect(toCopilotWindow({ unlimited: true, percent_remaining: 100 }, null)).toBeNull()
  })
})

describe('fetchCopilotRateLimits', () => {
  it('is unavailable when no login exists and never calls the API', async () => {
    const result = await fetchCopilotRateLimits({ configDir: dir, skipKeychain: true })

    expect(result).toMatchObject({ provider: 'copilot', status: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads the github.com token from apps.json and maps premium interactions', async () => {
    writeApps({
      'ghe.example.com:Iv1.x': { oauth_token: 'ghe-token' },
      'github.com:Iv1.b507a08c87ecfe98': { user: 'octo', oauth_token: 'gho_secret' }
    })
    vi.mocked(fetch).mockResolvedValue(jsonResponse(quotaBody))

    const result = await fetchCopilotRateLimits({ configDir: dir, skipKeychain: true })

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://api.github.com/copilot_internal/user')
    expect(init?.headers).toMatchObject({ Authorization: 'token gho_secret' })
    expect(init?.redirect).toBe('error')
    expect(result).toMatchObject({
      provider: 'copilot',
      status: 'ok',
      planType: 'enterprise',
      session: null,
      weekly: null,
      monthly: { usedPercent: 36, resetsAt: Date.parse(RESET) },
      usageMetadata: { credentialSource: 'github-copilot-config' }
    })
    expect(JSON.stringify(result)).not.toContain('gho_secret')
  })

  it('falls back to hosts.json', async () => {
    writeFileSync(join(dir, 'hosts.json'), JSON.stringify({ 'github.com': { oauth_token: 'h' } }))
    vi.mocked(fetch).mockResolvedValue(jsonResponse(quotaBody))

    const result = await fetchCopilotRateLimits({ configDir: dir, skipKeychain: true })

    expect(result.status).toBe('ok')
  })

  it.each([
    [401, 'stale-token'],
    [403, 'no-subscription'],
    [500, 'server']
  ])('maps HTTP %i to %s', async (status, failureKind) => {
    writeApps({ 'github.com:a': { oauth_token: 't' } })
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}, status))

    const result = await fetchCopilotRateLimits({ configDir: dir, skipKeychain: true })

    expect(result).toMatchObject({ status: 'error', usageMetadata: { failureKind } })
  })

  it('redacts the token from network errors', async () => {
    writeApps({ 'github.com:a': { oauth_token: 'gho_leak' } })
    vi.mocked(fetch).mockRejectedValue(new Error('boom gho_leak'))

    const result = await fetchCopilotRateLimits({ configDir: dir, skipKeychain: true })

    expect(result.error).toBe('boom [redacted]')
  })

  it('rejects a response without quota snapshots', async () => {
    writeApps({ 'github.com:a': { oauth_token: 't' } })
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ login: 'octo' }))

    const result = await fetchCopilotRateLimits({ configDir: dir, skipKeychain: true })

    expect(result).toMatchObject({ status: 'error', usageMetadata: { failureKind: 'parse' } })
  })

  it.runIf(process.platform === 'darwin')(
    'stops prompting the keychain after a denial',
    async () => {
      vi.mocked(execSecurityCommand).mockRejectedValue(
        Object.assign(new Error('denied'), { code: 51 })
      )

      const first = await fetchCopilotRateLimits({ configDir: dir })
      const second = await fetchCopilotRateLimits({ configDir: dir })

      expect(first.usageMetadata?.failureKind).toBe('keychain-unavailable')
      expect(second.status).toBe('unavailable')
      expect(execSecurityCommand).toHaveBeenCalledTimes(1)
    }
  )
})
