import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: vi.fn() } }))

import { withSetupSessionFallback } from './billing-setup-session-fallback'
import type { OrcaBillingCheckoutArgs, OrcaBillingLinkResult } from '../../shared/orca-billing'

const ARGS: OrcaBillingCheckoutArgs = {
  plan: 'team',
  interval: 'month',
  seats: 3,
  setupSessionId: 'cs_x'
}

describe('checkout "Copy link" setup-session fallback', () => {
  it('retries without the setup session when billing says it is for someone else', async () => {
    const run = vi.fn(async (args: OrcaBillingCheckoutArgs): Promise<OrcaBillingLinkResult> =>
      args.setupSessionId
        ? { status: 'failed', error: 'setup_session_mismatch' }
        : { status: 'ok', url: 'https://checkout.stripe.com/c/pay/cs_live_1' }
    )
    await expect(withSetupSessionFallback(ARGS, run)).resolves.toEqual({
      status: 'ok',
      url: 'https://checkout.stripe.com/c/pay/cs_live_1'
    })
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][0]).not.toHaveProperty('setupSessionId')
  })

  it('keeps any other refusal as it is', async () => {
    const run = vi.fn(async (): Promise<OrcaBillingLinkResult> => ({ status: 'forbidden' }))
    await expect(withSetupSessionFallback(ARGS, run)).resolves.toEqual({ status: 'forbidden' })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
