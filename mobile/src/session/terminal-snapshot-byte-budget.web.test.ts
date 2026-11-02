import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES } from '../mobile-web-shell/bridge/bridge-caps'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-envelope'
import { mobileTerminalSnapshotByteBudget as nativeBudget } from './terminal-snapshot-byte-budget'
import { bridgeEventEnvelopeBytes } from '../mobile-web-shell/bridge/bridge-event-envelope-bytes'
import { mobileTerminalSnapshotByteBudget } from './terminal-snapshot-byte-budget.web'

const WIDEST_ID = 'a'.repeat(22)

describe('the snapshot budget a phone sends', () => {
  it('is nothing at all, because the socket has no per-message cap', () => {
    expect(nativeBudget()).toBeUndefined()
  })
})

describe('the snapshot budget the page sends', () => {
  // Check real snapshot/data/ack frame shapes so the envelope estimate actually bounds every published payload.
  it.each([
    ['a scrollback snapshot', { type: 'scrollback', streamId: 7, serialized: '\u001b[0mhello' }],
    ['a live output chunk', { type: 'data', streamId: 7, chunk: 'x'.repeat(4096) }],
    ['a bare acknowledgement', { type: 'subscribed', streamId: 7 }],
    ['an empty object', {}]
  ])('never costs more than the envelope plus its payload: %s', (_label, payload) => {
    const frame = JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'event',
      id: WIDEST_ID,
      seq: Number.MAX_SAFE_INTEGER,
      payload
    })
    expect(frame.length).toBeLessThanOrEqual(
      bridgeEventEnvelopeBytes() + JSON.stringify(payload).length
    )
  })

  it('leaves a real snapshot event inside the cap when the payload spends the budget', () => {
    // Serialize a payload exactly at budget; guessed overhead could miss a frame that exceeds the cap.
    const budget = mobileTerminalSnapshotByteBudget() ?? 0
    const skeleton = JSON.stringify({ type: 'scrollback', streamId: 7, serialized: '' }).length
    const payload = { type: 'scrollback', streamId: 7, serialized: 'x'.repeat(budget - skeleton) }
    expect(JSON.stringify(payload).length).toBe(budget)
    const frame = JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'event',
      id: WIDEST_ID,
      seq: Number.MAX_SAFE_INTEGER,
      payload
    })
    expect(frame.length).toBeLessThanOrEqual(BRIDGE_MAX_MESSAGE_BYTES)
  })
})

// Pin the shared wire budget: host tests cannot import the mobile tsconfig and must detect drift independently.
describe('the number the page sends', () => {
  it('is 655,273 bytes: the 640 KiB cap less an 87-byte event envelope', () => {
    expect(bridgeEventEnvelopeBytes()).toBe(87)
    expect(mobileTerminalSnapshotByteBudget()).toBe(655_273)
  })
})
