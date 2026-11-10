import { describe, expect, it } from 'vitest'
import { devBillingEnforcePrefix, withDevAccountBypass, type EntitlementClient } from '../src/entitlements'
import type { Env } from '../src/env'

function billing() {
  const seen: string[] = []
  const client: EntitlementClient = {
    async checkStart(request) {
      seen.push(request.accountId)
      return { allow: false, reason: 'no_subscription', suspendRunning: false }
    },
    async reportUsage(segment) {
      seen.push(segment.accountId)
      return { canStartSandbox: false, reason: 'no_subscription', suspendRunning: false }
    },
    async listSuspensions() {
      return []
    }
  }
  return { client, seen }
}

const start = (accountId: string) => ({ accountId, machineSize: 'standard' as const, runningSandboxes: 0, userId: 'u', runningSandboxesForUser: 0 })

describe('SANDBOX_DEV_BILLING_ENFORCE_PREFIX', () => {
  it('sends only dev accounts under the prefix to the real billing gate (dev environment)', async () => {
    const { client, seen } = billing()
    const gate = withDevAccountBypass({ SANDBOX_ENV: 'dev', SANDBOX_DEV_BILLING_ENFORCE_PREFIX: 'dev:billing-test-' } as Env, client)
    expect(await gate.checkStart(start('dev:billing-test-alice'))).toMatchObject({ allow: false, reason: 'no_subscription' })
    expect(await gate.checkStart(start('dev:someone-else'))).toMatchObject({ allow: true })
    expect(await gate.reportUsage({ accountId: 'dev:billing-test-alice' } as never)).toMatchObject({ canStartSandbox: false })
    expect(seen).toEqual(['dev:billing-test-alice', 'dev:billing-test-alice'])
  })

  it('is ignored outside the dev environment, and for prefixes that would cover every dev account', () => {
    for (const SANDBOX_ENV of ['prod', 'staging', 'test', 'Dev']) {
      expect(devBillingEnforcePrefix({ SANDBOX_ENV, SANDBOX_DEV_BILLING_ENFORCE_PREFIX: 'dev:billing-test-' })).toBeNull()
    }
    for (const prefix of ['dev:', 'dev', '', 'billing-test-', 'dev:*', 'dev:billing test-']) {
      expect(devBillingEnforcePrefix({ SANDBOX_ENV: 'dev', SANDBOX_DEV_BILLING_ENFORCE_PREFIX: prefix })).toBeNull()
    }
    expect(devBillingEnforcePrefix({ SANDBOX_ENV: 'dev', SANDBOX_DEV_BILLING_ENFORCE_PREFIX: 'dev:billing-test-' })).toBe('dev:billing-test-')
  })

  it('outside dev, dev accounts keep the plain bypass even with the prefix set (prod sends everything to billing anyway)', async () => {
    const { client, seen } = billing()
    const staging = withDevAccountBypass({ SANDBOX_ENV: 'staging', SANDBOX_DEV_BILLING_ENFORCE_PREFIX: 'dev:billing-test-' } as Env, client)
    expect(await staging.checkStart(start('dev:billing-test-alice'))).toMatchObject({ allow: true })
    const prod = withDevAccountBypass({ SANDBOX_ENV: 'prod', SANDBOX_DEV_BILLING_ENFORCE_PREFIX: 'dev:billing-test-' } as Env, client)
    expect(await prod.checkStart(start('user:bob'))).toMatchObject({ allow: false })
    expect(seen).toEqual(['user:bob'])
  })
})
