import { describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const sessionFromPartitionMock = vi.hoisted(() =>
  vi.fn(() => ({
    clearStorageData: vi.fn(() => Promise.resolve()),
    cookies: { set: vi.fn(() => Promise.resolve()) },
    fetch: netFetchMock
  }))
)

vi.mock('electron', () => ({
  net: { fetch: netFetchMock },
  session: { fromPartition: sessionFromPartitionMock }
}))

import { fetchMiniMaxRateLimits } from './minimax-fetcher'
import { isProviderConfigured } from '../../renderer/src/components/status-bar/status-bar-provider-visibility'

const FULL_COOKIE =
  '_token=eyJh.eyJ.payload; _twpid=tw.123; minimax_group_id_v2=12345; platform_cookie_consent=3'

function makeResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

// Why: MiniMax reads `base_resp` and `model_remains` straight off the decoded body. On a JSON
// `null` that access throws, and the catch-all files the internal TypeError as a network failure
// whose message reaches the tooltip verbatim. See unreadable-usage-response.ts.
describe('MiniMax usage responses Orca cannot read', () => {
  const unreadableBodies: [string, unknown][] = [
    ['a JSON null body', null],
    ['a JSON array body', []],
    ['a bare string body', 'nope'],
    ['a bare number body', 7],
    ['a non-array model_remains', { base_resp: { status_code: 0 }, model_remains: 'none' }]
  ]

  for (const [label, body] of unreadableBodies) {
    it(`classifies ${label} as a failed read in Orca's own words`, async () => {
      netFetchMock.mockReset()
      netFetchMock.mockResolvedValueOnce(makeResponse(body))

      const result = await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE })

      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe('parse')
      expect(result.error).not.toMatch(/Cannot read propert/i)
      expect(isProviderConfigured(result)).toBe(true)
    })
  }
})
