import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_OPERATIONS,
  type MobileWebBridgeCapability
} from '../../../src/shared/mobile-web/bridge-operation-registry'
import {
  MOBILE_WEB_ONCE_CAPABILITY_ARMS,
  MOBILE_WEB_SUBSCRIPTION_CAPABILITY_ARMS
} from './mobile-web-capability-execution-arms'

/** Capabilities owning at least one operation of each request mode, read from the registry rather
 * than restated, so a new capability lands in the expectation on its own. */
function capabilitiesOwning(mode: 'once' | 'subscription'): MobileWebBridgeCapability[] {
  return Object.entries(MOBILE_WEB_BRIDGE_OPERATIONS)
    .filter(([, operations]) =>
      Object.values(operations).some((kind) =>
        mode === 'subscription' ? kind === 'subscription' : kind !== 'subscription'
      )
    )
    .map(([capability]) => capability as MobileWebBridgeCapability)
    .sort()
}

function registeredOperations(): {
  capability: MobileWebBridgeCapability
  operation: string
  kind: string
}[] {
  return Object.entries(MOBILE_WEB_BRIDGE_OPERATIONS).flatMap(([capability, operations]) =>
    Object.entries(operations).map(([operation, kind]) => ({
      capability: capability as MobileWebBridgeCapability,
      operation,
      kind
    }))
  )
}

describe('mobile web capability dispatch census', () => {
  // The census this replaces asked only whether the operation name appeared as some quoted literal
  // anywhere under the shell tree, which a comment or an unrelated string satisfied. This resolves
  // the dispatch table the broker actually calls.
  it('resolves every registered operation to a dispatch arm for its request mode', () => {
    const unresolved = registeredOperations().filter(({ capability, kind }) => {
      const arms =
        kind === 'subscription'
          ? MOBILE_WEB_SUBSCRIPTION_CAPABILITY_ARMS
          : MOBILE_WEB_ONCE_CAPABILITY_ARMS
      return typeof arms[capability] !== 'function'
    })

    expect(unresolved.map(({ capability, operation }) => `${capability}.${operation}`)).toEqual([])
    expect(registeredOperations()).toHaveLength(226)
  })

  it('carries a dispatch arm for exactly the capabilities that own operations of that mode', () => {
    expect(Object.keys(MOBILE_WEB_ONCE_CAPABILITY_ARMS).sort()).toEqual(capabilitiesOwning('once'))
    expect(Object.keys(MOBILE_WEB_SUBSCRIPTION_CAPABILITY_ARMS).sort()).toEqual(
      capabilitiesOwning('subscription')
    )
  })

  it('routes workspace and settings one-shot requests through the same adapter', () => {
    expect(MOBILE_WEB_ONCE_CAPABILITY_ARMS.settings).toBe(MOBILE_WEB_ONCE_CAPABILITY_ARMS.workspace)
  })
})
