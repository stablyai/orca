import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES } from '../mobile-web-shell/bridge/bridge-caps'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-envelope'
import { mobileTerminalSnapshotByteBudget as nativeBudget } from './terminal-snapshot-byte-budget'
import { bridgeEventEnvelopeBytes } from '../mobile-web-shell/bridge/bridge-event-envelope-bytes'
import { mobileTerminalSnapshotByteBudget } from './terminal-snapshot-byte-budget.web'

/** An id of the length the protocol's own pattern admits, which is what the bound is written for. */
const WIDEST_ID = 'a'.repeat(22)

describe('the snapshot budget a phone sends', () => {
  it('is nothing at all, because the socket has no per-message cap', () => {
    expect(nativeBudget()).toBeUndefined()
  })
})

describe('the snapshot budget the page sends', () => {
  it('is the frame cap less what the event costs around the payload', () => {
    expect(mobileTerminalSnapshotByteBudget()).toBe(
      BRIDGE_MAX_MESSAGE_BYTES - bridgeEventEnvelopeBytes()
    )
  })

  /**
   * The bound, checked against events of the shape the shell really posts.
   *
   * A budget derived from a skeleton is only a bound if a real frame never costs more than the
   * envelope plus what its payload serializes to. Checked across the payload shapes this stream
   * actually carries — a snapshot, a live output chunk, a bare acknowledgement — because the
   * envelope is fixed and the payload is not, and a bound that held only for one of them is not a
   * bound.
   */
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
    // The whole contract in one assertion: a payload that serializes to exactly the budget produces
    // a frame of at most the cap. The payload is built and measured rather than assembled from a
    // guess at its overhead, which is the same rule the desktop applies on its side.
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

  it('moves with the cap rather than beside it', () => {
    // A cap that moves and a budget that does not is a terminal that dies on a page it could have
    // streamed, which is what a literal here would have produced.
    expect(mobileTerminalSnapshotByteBudget()).toBeLessThan(BRIDGE_MAX_MESSAGE_BYTES)
    expect(mobileTerminalSnapshotByteBudget()).toBeGreaterThan(BRIDGE_MAX_MESSAGE_BYTES - 1024)
  })
})

/**
 * The number the desktop is handed, pinned so the host's own cases can name it.
 *
 * The host cannot import this — it is a different program with a different tsconfig — so its
 * budget cases restate the value with a pointer here. Pinned rather than derived on both sides so
 * a drift is a red line in one file rather than a stream that ends on a device.
 */
describe('the number the page sends', () => {
  it('is 655,273 bytes: the 640 KiB cap less an 87-byte event envelope', () => {
    expect(bridgeEventEnvelopeBytes()).toBe(87)
    expect(mobileTerminalSnapshotByteBudget()).toBe(655_273)
  })
})
