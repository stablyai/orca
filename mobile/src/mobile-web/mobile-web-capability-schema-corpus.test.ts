import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import {
  createMobileWebBrokerFixture,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'
const MALFORMED_PAYLOADS: unknown[] = [null, true, false, 0, 1.5, '', 'payload', []]

describe('mobile web capability schema corpus', () => {
  it('rejects non-object payloads for every production operation before host or native access', async () => {
    let caseIndex = 0
    for (const grant of MOBILE_WEB_PRODUCTION_GRANTS) {
      for (const payload of MALFORMED_PAYLOADS) {
        const harness = createHarness()
        await harness.broker.handle(requestFor(grant, payload, caseIndex))
        caseIndex += 1

        expect(
          harness.messages,
          `${grant.capability}.${grant.operation}: ${JSON.stringify(payload)}`
        ).toEqual([
          expect.objectContaining({
            status: 'error',
            error: { code: 'invalid_request', retryable: false }
          })
        ])
        expect(harness.sendRequest).not.toHaveBeenCalled()
        expect(harness.subscribe).not.toHaveBeenCalled()
        expect(harness.nativeCalls).toHaveLength(0)
      }
    }
    expect(caseIndex).toBe(MOBILE_WEB_PRODUCTION_GRANTS.length * MALFORMED_PAYLOADS.length)
  })

  it('applies every production request-byte limit before host or native access', async () => {
    for (const [index, grant] of MOBILE_WEB_PRODUCTION_GRANTS.entries()) {
      const harness = createHarness()
      const payload = { value: 'x'.repeat(grant.limits.maxRequestBytes + 1) }

      await harness.broker.handle(requestFor(grant, payload, index))

      expect(harness.messages).toEqual([
        expect.objectContaining({
          status: 'error',
          error: { code: 'too_large', retryable: false }
        })
      ])
      expect(harness.sendRequest).not.toHaveBeenCalled()
      expect(harness.subscribe).not.toHaveBeenCalled()
      expect(harness.nativeCalls).toHaveLength(0)
    }
  })
})

function createHarness() {
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const subscribe = vi.fn<RpcClient['subscribe']>()
  const nativeCalls: string[] = []
  const client = { sendRequest, subscribe } as unknown as RpcClient
  const { broker, messages } = createMobileWebBrokerFixture({
    getClient: () => client,
    nativeAuthority: {
      hapticFeedback: async () => {
        nativeCalls.push('haptic')
      },
      clipboardWrite: async () => {
        nativeCalls.push('clipboard')
      },
      openExternal: async () => {
        nativeCalls.push('external')
      },
      terminalPreferences: () => {
        nativeCalls.push('terminalPreferences')
        return { textScale: 1 }
      },
      terminalTextScaleUpdate: async () => {
        nativeCalls.push('terminalTextScale')
      }
    }
  })
  return { broker, messages, sendRequest, subscribe, nativeCalls }
}

function requestFor(
  grant: (typeof MOBILE_WEB_PRODUCTION_GRANTS)[number],
  payload: unknown,
  index: number
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  const requestId = index.toString(36).padStart(22, '0').slice(-22)
  return mobileWebBridgeRequestMessage({
    requestId,
    capability: grant.capability,
    operation: grant.operation,
    payload,
    ...(grant.operation === 'subscribe' ? { subscriptionId: `s${requestId.slice(1)}` } : {})
  })
}
