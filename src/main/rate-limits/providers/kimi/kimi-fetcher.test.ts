import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../../../network/http-client'
import { fetchKimiRateLimits } from './kimi-fetcher'

const SESSION_RESET = '2026-10-15T14:18:14.197Z'
const MONTHLY_RESET = '2026-11-15T09:19:24Z'

afterEach(() => setMainHttpClient(null))

it('shows the monthly pool beside the 5-hour window on a current Kimi Code plan', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-kimi-usage-'))
  try {
    mkdirSync(join(home, 'credentials'))
    writeFileSync(
      join(home, 'credentials', 'kimi-code.json'),
      JSON.stringify({ access_token: 'synthetic-kimi-token', expires_at: 4_000_000_000 })
    )
    const fetch = vi.fn(async () =>
      Response.json({
        limits: [
          {
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: { limit: '100', used: '40', remaining: '60', resetTime: SESSION_RESET }
          }
        ],
        usages: {
          limit_5h: { used_ratio: 0.4, reset_time: SESSION_RESET },
          limit_month_total: { used_ratio: 0.25, reset_time: MONTHLY_RESET },
          limit_month_code: { used_ratio: 0.9, reset_time: MONTHLY_RESET }
        }
      })
    )
    setMainHttpClient({ fetch, proxySession: () => null })

    const result = await fetchKimiRateLimits({
      home: { runtime: 'host', wslDistro: null, path: home }
    })

    expect(result.status).toBe('ok')
    expect(result.weekly).toBeNull()
    expect(result.session).toMatchObject({
      usedPercent: 40,
      windowMinutes: 300,
      resetsAt: Date.parse(SESSION_RESET)
    })
    expect(result.monthly).toMatchObject({
      usedPercent: 25,
      windowMinutes: 43_200,
      resetsAt: Date.parse(MONTHLY_RESET)
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
