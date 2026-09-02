import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const fsState = vi.hoisted<{ files: Record<string, string>; readError: Error | null }>(() => ({
  files: {},
  readError: null
}))
const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => path in fsState.files,
  readFileSync: (path: string) => {
    if (fsState.readError) {
      throw fsState.readError
    }
    if (!(path in fsState.files)) {
      throw new Error('ENOENT')
    }
    return fsState.files[path]
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { fetchCopilotRateLimits } from './copilot-fetcher'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

// Real shape captured from GET https://api.github.com/copilot_internal/user.
const USAGE_RESPONSE = {
  quota_snapshots: {
    premium_interactions: {
      percent_remaining: 72.5,
      unlimited: false,
      quota_reset_at: 1_800_000_000
    }
  },
  quota_reset_date_utc: '2026-10-01T00:00:00Z'
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

describe('fetchCopilotRateLimits', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    execFileMock.mockReset()
    fsState.files = {}
    fsState.readError = null
    setPlatform('linux')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('returns unavailable when no credentials file exists (Linux/Windows)', async () => {
    const result = await fetchCopilotRateLimits()
    expect(result.provider).toBe('copilot')
    expect(result.status).toBe('unavailable')
    expect(result.monthly).toBeNull()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('reads the token from hosts.json and maps the monthly quota window', async () => {
    fsState.files['/home/test/.config/github-copilot/hosts.json'] = JSON.stringify({
      'github.com': { oauth_token: 'gho_abc123' }
    })
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchCopilotRateLimits()

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('copilot')
    expect(result.monthly?.windowMinutes).toBe(30 * 24 * 60)
    expect(result.monthly?.usedPercent).toBeCloseTo(27.5)
    const [url, init] = netFetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/copilot_internal/user')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('token gho_abc123')
    expect(headers['Editor-Version']).toBeTruthy()
    expect(headers['User-Agent']).toBeTruthy()
  })

  it('falls back to the ISO reset date when quota_reset_at is 0 (unset, not epoch)', async () => {
    fsState.files['/home/test/.config/github-copilot/hosts.json'] = JSON.stringify({
      'github.com': { oauth_token: 'gho_abc123' }
    })
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        quota_snapshots: {
          premium_interactions: {
            percent_remaining: 50,
            unlimited: false,
            quota_reset_at: 0
          }
        },
        quota_reset_date_utc: '2026-10-01T00:00:00Z'
      })
    )

    const result = await fetchCopilotRateLimits()

    expect(result.status).toBe('ok')
    expect(result.monthly?.resetsAt).toBe(new Date('2026-10-01T00:00:00Z').getTime())
  })

  it('surfaces an error when the usage request fails', async () => {
    fsState.files['/home/test/.config/github-copilot/hosts.json'] = JSON.stringify({
      'github.com': { oauth_token: 'gho_abc123' }
    })
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 500))

    const result = await fetchCopilotRateLimits()
    expect(result.status).toBe('error')
    expect(result.monthly).toBeNull()
  })

  it('surfaces unauthorized distinctly without retrying', async () => {
    fsState.files['/home/test/.config/github-copilot/hosts.json'] = JSON.stringify({
      'github.com': { oauth_token: 'gho_abc123' }
    })
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 401))

    const result = await fetchCopilotRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/401/)
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats an empty token-exchange payload as an error', async () => {
    fsState.files['/home/test/.config/github-copilot/hosts.json'] = JSON.stringify({
      'github.com': { oauth_token: 'gho_abc123' }
    })
    netFetchMock.mockResolvedValueOnce(jsonResponse({}))

    const result = await fetchCopilotRateLimits()
    expect(result.status).toBe('error')
    expect(result.monthly).toBeNull()
  })

  it('surfaces an error when the credentials file cannot be read', async () => {
    fsState.files['/home/test/.config/github-copilot/hosts.json'] = 'irrelevant'
    fsState.readError = new Error('EACCES')

    const result = await fetchCopilotRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/EACCES/)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('reads the token from macOS Keychain via a single fixed service name', async () => {
    setPlatform('darwin')
    execFileMock.mockImplementation((_cmd, args, _opts, callback) => {
      expect(args).toContain('copilot-cli')
      callback(null, 'gho_keychain\n', '')
      return {} as unknown
    })
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchCopilotRateLimits()

    expect(result.status).toBe('ok')
    const [, init] = netFetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe('token gho_keychain')
  })

  it('returns unavailable when the Keychain entry is not found (never probes other service names)', async () => {
    setPlatform('darwin')
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(Object.assign(new Error('not found'), { code: 44 }), '', '')
      return {} as unknown
    })

    const result = await fetchCopilotRateLimits()

    expect(result.status).toBe('unavailable')
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})
