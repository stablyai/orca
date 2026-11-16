import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { supplementCodexUsageWindows } from './codex-backend-usage-client'

vi.mock('./codex-backend-auth', () => ({
  CODEX_BACKEND_TIMEOUT_MS: 10_000,
  getCodexBackendAuthHeaders: vi.fn(async () => ({ Authorization: 'Bearer test' }))
}))

describe('supplementCodexUsageWindows', () => {
  it('keeps the plan the usage response reports for a spend-capped seat', async () => {
    const rpc: ProviderRateLimits = {
      provider: 'codex',
      session: null,
      weekly: null,
      monthly: null,
      planType: 'unknown',
      updatedAt: 1,
      error: null,
      status: 'ok'
    }
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            plan_type: 'business',
            spend_control: { individual_limit: { remaining_percent: 80, reset_at: 2_000_000_000 } }
          })
        )
    )
    const limits = await supplementCodexUsageWindows(rpc, request)
    expect(limits.planType).toBe('business')
  })
})
