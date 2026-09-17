import { describe, expect, it } from 'vitest'
import { isUnsupportedAgentStatusStoreMethod } from './ssh-relay-status-negotiation'

describe('SSH agent-status store negotiation', () => {
  it('only treats an explicit method-not-found as legacy capability absence', () => {
    expect(isUnsupportedAgentStatusStoreMethod({ code: -32601 })).toBe(true)
    expect(isUnsupportedAgentStatusStoreMethod({ code: 'CONNECTION_LOST' })).toBe(false)
    expect(isUnsupportedAgentStatusStoreMethod({ code: 'DISPOSED' })).toBe(false)
    expect(isUnsupportedAgentStatusStoreMethod(new Error('status request failed'))).toBe(false)
  })
})
