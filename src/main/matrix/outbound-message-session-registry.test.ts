import { beforeEach, describe, expect, it } from 'vitest'
import {
  paneKeyForOutboundEvent,
  recordOutboundMessage,
  resetOutboundMessageRegistryForTests
} from './outbound-message-session-registry'

describe('outbound-message-session-registry', () => {
  beforeEach(() => {
    resetOutboundMessageRegistryForTests()
  })

  it('records and looks up an event -> paneKey mapping', () => {
    recordOutboundMessage('$evt1', 'pane-1')
    expect(paneKeyForOutboundEvent('$evt1')).toBe('pane-1')
  })

  it('returns null for an unknown event', () => {
    expect(paneKeyForOutboundEvent('$nope')).toBeNull()
  })

  it('re-recording the same event updates its paneKey', () => {
    recordOutboundMessage('$evt1', 'pane-1')
    recordOutboundMessage('$evt1', 'pane-2')
    expect(paneKeyForOutboundEvent('$evt1')).toBe('pane-2')
  })

  it('evicts the oldest entry once over the cap', () => {
    // Cap is 2000; fill past it and assert the earliest entry was evicted while a
    // recent one survives.
    const total = 2100
    for (let i = 0; i < total; i += 1) {
      recordOutboundMessage(`$evt${i}`, `pane-${i}`)
    }
    // The first (total - 2000) = 100 entries should be evicted.
    expect(paneKeyForOutboundEvent('$evt0')).toBeNull()
    expect(paneKeyForOutboundEvent('$evt99')).toBeNull()
    // Entries within the most-recent 2000 survive.
    expect(paneKeyForOutboundEvent('$evt100')).toBe('pane-100')
    expect(paneKeyForOutboundEvent(`$evt${total - 1}`)).toBe(`pane-${total - 1}`)
  })

  it("refreshing an event's recency protects it from eviction", () => {
    recordOutboundMessage('$keep', 'pane-keep')
    // Push the cap with fresh events, but refresh $keep partway so it is not the
    // oldest when eviction kicks in.
    for (let i = 0; i < 1500; i += 1) {
      recordOutboundMessage(`$a${i}`, `pane-a${i}`)
    }
    recordOutboundMessage('$keep', 'pane-keep') // move to most-recent
    for (let i = 0; i < 1500; i += 1) {
      recordOutboundMessage(`$b${i}`, `pane-b${i}`)
    }
    expect(paneKeyForOutboundEvent('$keep')).toBe('pane-keep')
  })
})
