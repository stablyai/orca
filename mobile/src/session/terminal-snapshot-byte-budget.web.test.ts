import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES } from '../mobile-web-shell/bridge/bridge-caps'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-envelope'
import { mobileTerminalSnapshotByteBudget as nativeBudget } from './terminal-snapshot-byte-budget'
import {
  bridgeEventEnvelopeBytes,
  mobileTerminalSnapshotByteBudget
} from './terminal-snapshot-byte-budget.web'

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
   * The bound, checked against an event of the shape the shell really posts.
   *
   * A budget derived from a skeleton is only a bound if the skeleton is the widest frame: a real
   * event with an empty payload must fit inside it, and one with a payload must leave the payload
   * exactly the room the budget promised.
   */
  it('covers the widest frame the shell can write around an empty payload', () => {
    const frame = JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'event',
      id: WIDEST_ID,
      seq: Number.MAX_SAFE_INTEGER,
      payload: {}
    })
    expect(frame.length).toBeLessThanOrEqual(bridgeEventEnvelopeBytes())
  })

  it('leaves a real snapshot event inside the cap when the payload spends the budget', () => {
    // The whole contract in one assertion: a payload of exactly the budget produces a frame of at
    // most the cap. `serialized` is plain ASCII here because what is being checked is the
    // arithmetic, not the escaping — the host is what measures escaping, against this number.
    const budget = mobileTerminalSnapshotByteBudget() ?? 0
    // `{"type":"scrollback","serialized":"..."}`: the payload braces are already in the envelope
    // bound, so the text may occupy the budget less what the payload's own keys cost.
    const keys = JSON.stringify({ type: 'scrollback', serialized: '' }).length - 2
    const serialized = 'x'.repeat(budget - keys - 2)
    const frame = JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'event',
      id: WIDEST_ID,
      seq: Number.MAX_SAFE_INTEGER,
      payload: { type: 'scrollback', serialized }
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
