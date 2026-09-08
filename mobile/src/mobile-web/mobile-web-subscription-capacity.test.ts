import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS } from '../../../src/shared/mobile-web/bridge-limits'
import { MOBILE_WEB_PRODUCTION_GRANT_INDEX } from './mobile-web-production-grants'
import { mobileWebIsHostRequest, mobileWebRequestAtCapacity } from './mobile-web-request-accounting'

describe('aggregate subscription admission', () => {
  it('counts pending generic streams alongside active legacy and terminal streams', () => {
    const pending = new Map([
      ['pending', { operationKey: 'workspace.hostSubscribe', subscriptionId: 'pending-stream' }]
    ])
    const args = {
      pending,
      request: {
        mode: 'subscription' as const,
        capability: 'workspace',
        operation: 'hostSubscribe'
      },
      ledgers: [
        {
          countForOperation: (key: string) =>
            key === 'terminal.subscribe' ? MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS - 1 : 0
        }
      ],
      isHostRequest: false,
      hostRequestsInFlight: 0,
      maxConcurrent: 8
    }
    expect(mobileWebRequestAtCapacity(args)).toBe(true)
    pending.clear()
    expect(mobileWebRequestAtCapacity(args)).toBe(false)
  })

  it('retains the actual host work ceiling after page cancellation removes pending state', () => {
    const args = {
      pending: new Map(),
      request: { mode: 'once' as const, capability: 'workspace', operation: 'hostRequest' },
      ledgers: [],
      isHostRequest: true,
      maxConcurrent: 8
    }
    expect(mobileWebRequestAtCapacity({ ...args, hostRequestsInFlight: 8 })).toBe(true)
    expect(mobileWebRequestAtCapacity({ ...args, hostRequestsInFlight: 7 })).toBe(false)
  })

  it('takes the host-request ceiling from the granted budget, not a private literal', () => {
    const grant = MOBILE_WEB_PRODUCTION_GRANT_INDEX.get('workspace.hostRequest')
    expect(grant).toBeDefined()
    const atCapacity = (hostRequestsInFlight: number) =>
      mobileWebRequestAtCapacity({
        pending: new Map(),
        request: { mode: 'once', capability: 'workspace', operation: 'hostRequest' },
        ledgers: [],
        isHostRequest: true,
        hostRequestsInFlight,
        maxConcurrent: grant!.limits.maxConcurrent
      })
    expect(atCapacity(grant!.limits.maxConcurrent - 1)).toBe(false)
    expect(atCapacity(grant!.limits.maxConcurrent)).toBe(true)
  })

  it('leaves host streams off the one-shot host ceiling', () => {
    expect(mobileWebIsHostRequest({ capability: 'workspace', operation: 'hostRequest' })).toBe(true)
    expect(mobileWebIsHostRequest({ capability: 'workspace', operation: 'hostSubscribe' })).toBe(
      false
    )
  })
})
