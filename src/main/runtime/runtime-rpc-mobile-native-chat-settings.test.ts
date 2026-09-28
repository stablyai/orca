import { describe, expect, it } from 'vitest'
import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc/runtime-rpc-mobile-method-allowlist'

describe('mobile native-chat settings RPC', () => {
  it('allows a paired phone to persist a structured option pick', () => {
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('settings.mutateNativeChatSessionOptions')).toBe(true)
  })
})
