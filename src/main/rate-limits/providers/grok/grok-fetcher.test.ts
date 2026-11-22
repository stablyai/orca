import { afterEach, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../../../network/http-client'
import { fetchGrokRateLimits } from './grok-fetcher'

const PERIOD_START = '2026-11-13T03:02:56.191+00:00'
const PERIOD_END = '2026-11-20T03:02:56.191+00:00'
const WEEKLY_PERIOD = {
  currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: PERIOD_START, end: PERIOD_END },
  prepaidBalance: { val: 0 },
  billingPeriodStart: PERIOD_START,
  billingPeriodEnd: PERIOD_END
}
const ZERO_DEFAULT_VIEW = { monthlyLimit: { val: 0 }, used: { val: 0 }, onDemandCap: { val: 0 } }
const UNAVAILABLE = {
  status: 'unavailable',
  error: 'Grok did not report a usage percentage for this account',
  weekly: null
}

afterEach(() => setMainHttpClient(null))

it.each([
  {
    name: 'default view confirms a zero cap and no spend (#44412)',
    credits: WEEKLY_PERIOD,
    defaultView: ZERO_DEFAULT_VIEW,
    expected: {
      status: 'ok',
      error: null,
      weekly: { usedPercent: 0, resetsAt: Date.parse(PERIOD_END) }
    }
  },
  {
    name: 'credits used 0 does not hide default-view used 37.5',
    credits: { ...WEEKLY_PERIOD, used: { val: 0 } },
    defaultView: { ...ZERO_DEFAULT_VIEW, used: { val: 37.5 } },
    expected: UNAVAILABLE
  }
])(
  'maps a percent-free weekly credits view when the $name',
  async ({ credits, defaultView, expected }) => {
    setMainHttpClient({
      fetch: vi.fn(async (url: string) =>
        Response.json({ config: url.endsWith('format=credits') ? credits : defaultView })
      ),
      proxySession: () => null
    })

    const result = await fetchGrokRateLimits({
      authReadResult: {
        status: 'ok',
        session: {
          accessToken: 'synthetic-grok-token',
          userId: 'user-1',
          email: null,
          teamId: null,
          expiresAtMs: null,
          oidcClientId: null
        }
      }
    })

    expect(result).toMatchObject(expected)
  }
)
