import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_MAX_GRANTS,
  MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES,
  MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES,
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  MobileWebBridgeShellMessageSchema
} from '../../../src/shared/mobile-web/bridge-contract'
import { MOBILE_WEB_BRIDGE_OPERATIONS } from '../../../src/shared/mobile-web/bridge-operation-registry'
import { MOBILE_WEB_CLIPBOARD_TEXT_MAX_CHARACTERS } from '../../../src/shared/mobile-web/native-operation-contract'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'
import { mobileWebRequestExpectsSubscription } from './mobile-web-request-accounting'

describe('mobile web production grant limits', () => {
  it('grants every named production operation exactly once', () => {
    const registered = Object.entries(MOBILE_WEB_BRIDGE_OPERATIONS)
      .flatMap(([capability, operations]) =>
        Object.keys(operations).map((operation) => `${capability}.${operation}`)
      )
      .sort()
    const granted = MOBILE_WEB_PRODUCTION_GRANTS.map(
      (grant) => `${grant.capability}.${grant.operation}`
    ).sort()

    expect(granted).toEqual(registered)
    expect(granted.length).toBeLessThan(MOBILE_WEB_BRIDGE_MAX_GRANTS)
  })

  it('leaves initial-message headroom for additive same-version grants', () => {
    const parsed = MobileWebBridgeShellMessageSchema.safeParse({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'init',
      shellSessionId: 'S'.repeat(43),
      buildId: 'a'.repeat(64),
      connection: 'connected',
      grants: [
        ...MOBILE_WEB_PRODUCTION_GRANTS,
        {
          capability: 'native',
          operation: 'futureOperation',
          limits: MOBILE_WEB_PRODUCTION_GRANTS[0]!.limits
        }
      ]
    })

    expect(parsed.success, parsed.success ? undefined : parsed.error.message).toBe(true)
  })

  it('leaves bounded envelope capacity around every operation payload', () => {
    for (const grant of MOBILE_WEB_PRODUCTION_GRANTS) {
      expect(grant.limits.maxRequestBytes).toBeLessThanOrEqual(
        MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES
      )
      expect(grant.limits.maxResponseBytes).toBeLessThanOrEqual(
        MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES
      )
    }
    const init = {
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'init',
      shellSessionId: 'S'.repeat(43),
      buildId: 'a'.repeat(64),
      connection: 'connected',
      grants: [...MOBILE_WEB_PRODUCTION_GRANTS]
    }
    const parsed = MobileWebBridgeShellMessageSchema.safeParse(init)
    expect(parsed.success, parsed.success ? undefined : parsed.error.message).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(init)).byteLength).toBeLessThan(
      MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES
    )
  })

  it('admits the worst-case bounded UTF-8 clipboard request', () => {
    const grant = MOBILE_WEB_PRODUCTION_GRANTS.find(
      (candidate) => candidate.capability === 'native' && candidate.operation === 'clipboardWrite'
    )
    const payload = { text: '\u{10ffff}'.repeat(MOBILE_WEB_CLIPBOARD_TEXT_MAX_CHARACTERS) }
    expect(grant).toBeDefined()
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(
      grant!.limits.maxRequestBytes
    )
  })

  it('classifies every production subscribe grant as a subscription request', () => {
    const subscribeGrants = MOBILE_WEB_PRODUCTION_GRANTS.filter(
      (grant) => grant.operation === 'subscribe'
    )

    expect(subscribeGrants.length).toBeGreaterThan(0)
    for (const grant of subscribeGrants) {
      expect(mobileWebRequestExpectsSubscription(grant)).toBe(true)
    }
  })
})
