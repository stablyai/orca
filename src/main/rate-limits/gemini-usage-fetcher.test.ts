import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock, execSyncMock, netFetchMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  execSyncMock: vi.fn(),
  netFetchMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('node:child_process', () => ({
  execSync: execSyncMock
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchGeminiRateLimits } from './gemini-usage-fetcher'

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  } as Response
}

describe('fetchGeminiRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    readFileMock.mockReset()
    execSyncMock.mockReset()
    netFetchMock.mockReset()
  })

  const validCreds = {
    access_token: 'valid-token',
    refresh_token: 'refresh-token',
    expiry_date: new Date('2026-04-24T13:00:00.000Z').getTime()
  }

  const expiredCreds = {
    access_token: 'expired-token',
    refresh_token: 'refresh-token',
    expiry_date: new Date('2026-04-24T11:00:00.000Z').getTime()
  }

  const oauth2JsContent = `
    const OAUTH_CLIENT_ID = 'client-id-123';
    const OAUTH_CLIENT_SECRET = 'client-secret-456';
  `

  const quotaResponse = [
    { remainingFraction: 0.75, resetTime: '2026-04-24T13:00:00.000Z', modelId: 'gemini-pro' },
    { remainingFraction: 0.9, resetTime: '2026-04-24T14:00:00.000Z', modelId: 'gemini-flash' }
  ]

  it('returns unavailable when credentials are not found', async () => {
    readFileMock.mockRejectedValue({ code: 'ENOENT' })

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('unavailable')
    expect(result.provider).toBe('gemini')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.error).toContain('credentials not found')
  })

  it('returns quota with correct usedPercent for pro and flash when token is valid', async () => {
    readFileMock.mockResolvedValue(JSON.stringify(validCreds))
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('gemini')
    expect(result.error).toBeNull()

    expect(result.session).toEqual({
      usedPercent: 25,
      windowMinutes: 60,
      resetsAt: new Date('2026-04-24T13:00:00.000Z').getTime(),
      resetDescription: null
    })

    expect(result.weekly).toEqual({
      usedPercent: 10,
      windowMinutes: 120,
      resetsAt: new Date('2026-04-24T14:00:00.000Z').getTime(),
      resetDescription: null
    })
  })

  it('refreshes token when expired and returns quota', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(expiredCreds)
      }
      if (filePath.includes('oauth2.js')) {
        return oauth2JsContent
      }
      throw new Error('Unexpected readFile call')
    })
    execSyncMock.mockReturnValue('/usr/local/bin/gemini')
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ access_token: 'new-token' }))
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('gemini')
    expect(result.error).toBeNull()
    expect(result.session).not.toBeNull()

    const refreshCall = netFetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('oauth2.googleapis.com')
    )
    expect(refreshCall).toBeDefined()
  })

  it('returns error when token refresh fails', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(expiredCreds)
      }
      if (filePath.includes('oauth2.js')) {
        return oauth2JsContent
      }
      throw new Error('Unexpected readFile call')
    })
    execSyncMock.mockReturnValue('/usr/local/bin/gemini')
    netFetchMock.mockResolvedValueOnce(makeResponse({ error: 'invalid_grant' }, 400))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh failed')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('proceeds with empty projectId when loadCodeAssist fails', async () => {
    readFileMock.mockResolvedValue(JSON.stringify(validCreds))
    netFetchMock
      .mockResolvedValueOnce(makeResponse('Internal Server Error', 500))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.session).not.toBeNull()

    const quotaCall = netFetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('retrieveUserQuota')
    )
    expect(quotaCall).toBeDefined()
    const quotaBody = JSON.parse((quotaCall![1] as RequestInit).body as string)
    expect(quotaBody.project).toBe('')
  })

  it('maps mixed pro/flash buckets correctly with lowest remainingFraction winning', async () => {
    const mixedResponse = [
      { remainingFraction: 0.8, resetTime: '2026-04-24T13:00:00.000Z', modelId: 'gemini-pro-1.5' },
      { remainingFraction: 0.5, resetTime: '2026-04-24T13:30:00.000Z', modelId: 'gemini-pro-2.0' },
      {
        remainingFraction: 0.9,
        resetTime: '2026-04-24T14:00:00.000Z',
        modelId: 'gemini-flash-1.5'
      },
      { remainingFraction: 0.6, resetTime: '2026-04-24T14:30:00.000Z', modelId: 'gemini-flash-2.0' }
    ]

    readFileMock.mockResolvedValue(JSON.stringify(validCreds))
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      .mockResolvedValueOnce(makeResponse(mixedResponse))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    // pro: lowest remainingFraction is 0.5 -> usedPercent 50
    expect(result.session).toEqual({
      usedPercent: 50,
      windowMinutes: 90,
      resetsAt: new Date('2026-04-24T13:30:00.000Z').getTime(),
      resetDescription: null
    })
    // flash: lowest remainingFraction is 0.6 -> usedPercent 40
    expect(result.weekly).toEqual({
      usedPercent: 40,
      windowMinutes: 150,
      resetsAt: new Date('2026-04-24T14:30:00.000Z').getTime(),
      resetDescription: null
    })
  })

  it('returns session null when no pro buckets exist', async () => {
    const flashOnly = [
      { remainingFraction: 0.7, resetTime: '2026-04-24T13:00:00.000Z', modelId: 'gemini-flash' }
    ]

    readFileMock.mockResolvedValue(JSON.stringify(validCreds))
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      .mockResolvedValueOnce(makeResponse(flashOnly))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.session).toBeNull()
    expect(result.weekly).not.toBeNull()
    expect(result.weekly?.usedPercent).toBe(30)
  })

  it('returns error on 401 from quota fetch when token refresh fails', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(validCreds)
      }
      if (filePath.includes('oauth2.js')) {
        return oauth2JsContent
      }
      throw new Error('Unexpected readFile call')
    })
    execSyncMock.mockReturnValue('/usr/local/bin/gemini')
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      .mockResolvedValueOnce(makeResponse('Unauthorized', 401))
      .mockResolvedValueOnce(makeResponse({ error: 'invalid_grant' }, 400))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('Token refresh failed')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('refreshes token on 401 from quota fetch and retries successfully', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(validCreds)
      }
      if (filePath.includes('oauth2.js')) {
        return oauth2JsContent
      }
      throw new Error('Unexpected readFile call')
    })
    execSyncMock.mockReturnValue('/usr/local/bin/gemini')
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      .mockResolvedValueOnce(makeResponse('Unauthorized', 401))
      .mockResolvedValueOnce(makeResponse({ access_token: 'refreshed-token' }))
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      .mockResolvedValueOnce(makeResponse(quotaResponse))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.session).not.toBeNull()

    const refreshCall = netFetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('oauth2.googleapis.com')
    )
    expect(refreshCall).toBeDefined()
  })

  it('returns error when quota fetch 401 and retry also 401', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('oauth_creds.json')) {
        return JSON.stringify(validCreds)
      }
      if (filePath.includes('oauth2.js')) {
        return oauth2JsContent
      }
      throw new Error('Unexpected readFile call')
    })
    execSyncMock.mockReturnValue('/usr/local/bin/gemini')
    netFetchMock
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      .mockResolvedValueOnce(makeResponse('Unauthorized', 401))
      .mockResolvedValueOnce(makeResponse({ access_token: 'refreshed-token' }))
      .mockResolvedValueOnce(makeResponse({ cloudaicompanionProject: 'proj-123' }))
      .mockResolvedValueOnce(makeResponse('Unauthorized', 401))

    const result = await fetchGeminiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('Quota fetch failed (401)')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })
})
