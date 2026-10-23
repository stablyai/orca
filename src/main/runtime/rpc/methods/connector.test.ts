import { describe, expect, it } from 'vitest'
import { requireSeam } from './connector'

describe('connector RPC methods', () => {
  it('are refused while the host has connectors off', () => {
    expect(() => requireSeam({ getExternalConversationSeam: () => null })).toThrow(
      'connectors_disabled'
    )
  })
})
