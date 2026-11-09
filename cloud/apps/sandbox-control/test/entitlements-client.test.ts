import { describe, expect, it } from 'vitest'
import { BillingUnavailableError, createEntitlementClient } from '../src/entitlements'
import type { Env } from '../src/env'

const env = { BILLING_URL: 'https://billing.test', CONTROL_PLANE_TOKEN: 'cp_'.padEnd(40, 'x'), SANDBOX_ENV: 'dev' } as Env

describe('billing client', () => {
  it('reads billing dev answers, including grace-expired suspensions', async () => {
    const seen: string[] = []
    const client = createEntitlementClient(env, async (input, init) => {
      const url = new URL(String(input))
      seen.push(`${init?.method} ${url.pathname} ${new Headers(init?.headers).get('authorization')}`)
      if (url.pathname === '/v1/internal/suspensions') {
        return Response.json({ accounts: [{ accountId: 'org:o1', pastDueSince: 1, graceEndsAt: 2 }] })
      }
      // Live billing dev answers seats 0 / cap 0 for an account without a subscription.
      return Response.json({ allow: false, reason: 'payment_grace_expired', suspendRunning: true, seats: 0, maxConcurrentSandboxes: 0, entitlement: {} })
    })
    expect(await client.listSuspensions()).toEqual(['org:o1'])
    expect(await client.checkStart({ accountId: 'org:o1', machineSize: 'standard', runningSandboxes: 0 })).toEqual({
      allow: false,
      reason: 'payment_grace_expired',
      suspendRunning: true,
      seats: 0,
      maxConcurrentSandboxes: 0,
      entitlement: {}
    })
    expect(seen[0]).toBe(`GET /v1/internal/suspensions Bearer ${env.CONTROL_PLANE_TOKEN}`)
  })

  it('fails closed when billing is unreachable and refuses the stub in prod', async () => {
    const down = createEntitlementClient(env, async () => {
      throw new Error('offline')
    })
    await expect(down.checkStart({ accountId: 'a', machineSize: 'large', runningSandboxes: 0 })).rejects.toBeInstanceOf(
      BillingUnavailableError
    )
    expect(() => createEntitlementClient({ ...env, ENTITLEMENTS_MODE: 'stub', SANDBOX_ENV: 'prod' })).toThrow(
      BillingUnavailableError
    )
  })
})
