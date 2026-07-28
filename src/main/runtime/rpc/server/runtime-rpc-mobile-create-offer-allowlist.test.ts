import { describe, expect, it } from 'vitest'
import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc-mobile-method-allowlist'

describe('mobile RPC method allowlist', () => {
  it('does not let mobile credentials mint access grants', () => {
    // Why: mobile scope exists to keep repo/provisioning primitives out of reach;
    // pairing.createOffer would escalate a phone token into new runtime grants.
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('pairing.createOffer')).toBe(false)
  })
})
