import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authJsonGoogle, makeResponse } from './gemini-usage-fetcher.test-fixtures'

const { readFileMock, extractCredsMock, netFetchMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  extractCredsMock: vi.fn(),
  netFetchMock: vi.fn()
}))

vi.mock('./gemini-cli-oauth-extractor', () => ({
  extractOAuthClientCredentials: extractCredsMock
}))
vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

import { fetchGeminiRateLimits } from './gemini-usage-fetcher'

const USABLE_BUCKET = {
  remainingFraction: 0.4,
  resetTime: '2026-04-24T18:00:00.000Z',
  modelId: 'gemini-2.5-pro'
}

function respondToQuotaWith(body: unknown): void {
  netFetchMock.mockImplementation((url: string) => {
    if (url.includes('retrieveUserQuota')) {
      return Promise.resolve(makeResponse(body))
    }
    if (url.includes('loadCodeAssist')) {
      return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-123' }))
    }
    return Promise.resolve(makeResponse({}, 404))
  })
}

// Why: `ok` is what the stale policy writes over the account's last real usage, so a quota body
// Orca could not read must not settle as one. An envelope that really carries zero buckets is a
// different fact and stays `ok`.
describe('Gemini quota responses that yield no bucket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    readFileMock.mockReset()
    extractCredsMock.mockReset()
    netFetchMock.mockReset()
    extractCredsMock.mockResolvedValue(null)
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('auth.json')) {
        return JSON.stringify(authJsonGoogle)
      }
      throw { code: 'ENOENT' }
    })
  })

  const unreadableBodies: [string, unknown][] = [
    ['an HTTP-200 error envelope', { error: { code: 429, message: 'quota exceeded' } }],
    ['a renamed buckets field', { quotaBuckets: [USABLE_BUCKET] }],
    ['a bare string', 'nope'],
    ['a null body', null],
    ['an envelope whose every bucket is malformed', [{ remainingFraction: 'lots' }]]
  ]

  for (const [label, body] of unreadableBodies) {
    it(`does not report ${label} as a successful quota reading`, async () => {
      respondToQuotaWith(body)

      const result = await fetchGeminiRateLimits(true)

      expect(result.status).toBe('error')
      expect(result.error).toBeTruthy()
      expect(result.session).toBeNull()
    })
  }

  const emptyEnvelopes: [string, unknown][] = [
    ['a bare empty array', []],
    ['a wrapped empty bucket list', { buckets: [] }]
  ]

  for (const [label, body] of emptyEnvelopes) {
    it(`still reports ${label} as a genuinely empty reading`, async () => {
      respondToQuotaWith(body)

      const result = await fetchGeminiRateLimits(true)

      expect(result.status).toBe('ok')
      expect(result.buckets).toEqual([])
    })
  }

  it('still reports a readable bucket as a successful reading', async () => {
    respondToQuotaWith([USABLE_BUCKET])

    const result = await fetchGeminiRateLimits(true)

    expect(result.status).toBe('ok')
    expect(result.buckets).toHaveLength(1)
    expect(result.session?.usedPercent).toBe(60)
  })
})
