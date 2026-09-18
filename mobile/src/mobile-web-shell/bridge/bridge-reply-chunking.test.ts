import { describe, expect, it } from 'vitest'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_REPLY_BYTES,
  BRIDGE_MAX_REPLY_PARTS,
  utf8ByteLength
} from './bridge-caps'
import {
  BRIDGE_PROTOCOL_VERSION,
  readBridgeHostMessage,
  type BridgeReplyMessage,
  type BridgeReplyPayload
} from './bridge-envelope'
import {
  BridgeReplyAssembler,
  splitBridgeReply,
  type BridgeReplySplit
} from './bridge-reply-chunking'

const ID = 'AAAAAAAAAAAAAAAAAAAAAA'
const OTHER_ID = 'BBBBBBBBBBBBBBBBBBBBBB'
/** A control character is the worst a JSON string literal can do to a byte: one becomes six. */
const WORST_ESCAPING_CHARACTER = String.fromCharCode(1)

function payloadOf(result: unknown): BridgeReplyPayload {
  return { id: 'r1', ok: true, result, _meta: { runtimeId: 'runtime-a' } }
}

function part(i: number, of: number, chunk: string, id = ID): BridgeReplyMessage {
  return { v: BRIDGE_PROTOCOL_VERSION, type: 'reply', id, part: { i, of }, chunk }
}

function framesOf(split: BridgeReplySplit): BridgeReplyMessage[] {
  if (!split.ok) {
    throw new Error(`expected a split, got ${split.refusal}`)
  }
  return split.frames
}

/** Feeds frames in the given order and returns the assembler's answer to the last one. */
function assemble(frames: BridgeReplyMessage[]): ReturnType<BridgeReplyAssembler['accept']> {
  const assembler = new BridgeReplyAssembler()
  let answer: ReturnType<BridgeReplyAssembler['accept']> = { status: 'pending' }
  for (const frame of frames) {
    answer = assembler.accept(frame)
  }
  return answer
}

describe('splitBridgeReply', () => {
  it('leaves a reply that fits in one frame unchunked', () => {
    const payload = payloadOf({ worktrees: ['a', 'b'] })
    const frames = framesOf(splitBridgeReply(ID, payload))
    expect(frames).toEqual([{ v: BRIDGE_PROTOCOL_VERSION, type: 'reply', id: ID, payload }])
  })

  it('chunks a reply over the frame cap', () => {
    const frames = framesOf(splitBridgeReply(ID, payloadOf('x'.repeat(1_500_000))))
    expect(frames.length).toBeGreaterThan(2)
    expect(frames.map((frame) => ('part' in frame ? frame.part.i : -1))).toEqual(
      frames.map((_, index) => index)
    )
  })

  it('ships only frames the receiving side will accept', () => {
    for (const frame of framesOf(splitBridgeReply(ID, payloadOf('x'.repeat(1_500_000))))) {
      const raw = JSON.stringify(frame)
      expect(utf8ByteLength(raw)).toBeLessThanOrEqual(BRIDGE_MAX_MESSAGE_BYTES)
      expect(readBridgeHostMessage(raw).ok).toBe(true)
    }
  })

  it('splits the worst reply the ceiling admits into fewer parts than the schema allows', () => {
    // Every character re-escapes, which is the most a chunk can grow by, at the largest reply that
    // can be sent at all. If this count ever reaches the part cap, the cap is the wrong number.
    const empty = payloadOf('')
    const backslashes = Math.floor((BRIDGE_MAX_REPLY_BYTES - JSON.stringify(empty).length) / 2)
    const payload = payloadOf('\\'.repeat(backslashes))
    expect(utf8ByteLength(JSON.stringify(payload))).toBeLessThanOrEqual(BRIDGE_MAX_REPLY_BYTES)
    expect(utf8ByteLength(JSON.stringify(payload))).toBeGreaterThan(BRIDGE_MAX_REPLY_BYTES - 4)
    const frames = framesOf(splitBridgeReply(ID, payload))
    expect(frames.length).toBe(26)
    expect(BRIDGE_MAX_REPLY_PARTS).toBeGreaterThan(frames.length)
    for (const frame of frames) {
      expect(utf8ByteLength(JSON.stringify(frame))).toBeLessThanOrEqual(BRIDGE_MAX_MESSAGE_BYTES)
      expect(readBridgeHostMessage(JSON.stringify(frame)).ok).toBe(true)
    }
  })

  it('stays under the frame cap when every byte escapes to six', () => {
    const payload = payloadOf(WORST_ESCAPING_CHARACTER.repeat(1_300_000))
    const frames = framesOf(splitBridgeReply(ID, payload))
    expect(frames.length).toBeLessThanOrEqual(BRIDGE_MAX_REPLY_PARTS)
    for (const frame of frames) {
      expect(utf8ByteLength(JSON.stringify(frame))).toBeLessThanOrEqual(BRIDGE_MAX_MESSAGE_BYTES)
    }
  })

  it('refuses a reply over the ceiling instead of chunking it forever', () => {
    const oversized = payloadOf('x'.repeat(BRIDGE_MAX_REPLY_BYTES + 1))
    expect(splitBridgeReply(ID, oversized)).toEqual({ ok: false, refusal: 'reply-too-large' })
  })

  it('chunks a reply of just under the ceiling', () => {
    const atCeiling = payloadOf('x'.repeat(BRIDGE_MAX_REPLY_BYTES - 200))
    expect(utf8ByteLength(JSON.stringify(atCeiling))).toBeLessThanOrEqual(BRIDGE_MAX_REPLY_BYTES)
    expect(splitBridgeReply(ID, atCeiling).ok).toBe(true)
  })
})

describe('round trip', () => {
  const payloads: [string, BridgeReplyPayload][] = [
    ['a small reply', payloadOf({ ok: 1 })],
    ['a reply spanning several frames', payloadOf('x'.repeat(1_500_000))],
    ['a reply of astral characters', payloadOf('\u{1f600}'.repeat(400_000))],
    ['a reply of control characters', payloadOf(WORST_ESCAPING_CHARACTER.repeat(1_300_000))],
    ['a reply of mixed widths', payloadOf(`${'é'.repeat(300_000)}${'中'.repeat(300_000)}`)]
  ]

  for (const [name, payload] of payloads) {
    it(`reassembles ${name} byte for byte`, () => {
      expect(assemble(framesOf(splitBridgeReply(ID, payload)))).toEqual({
        status: 'complete',
        payload
      })
    })
  }

  it('restores a surrogate pair that was cut in half between two frames', () => {
    // Each half is a lone surrogate, which `JSON.stringify` escapes rather than corrupting, so the
    // pair comes back whole once the halves are joined.
    const head = '{"id":"r1","ok":true,"result":"\ud83d'
    const tail = '\ude00","_meta":{"runtimeId":"runtime-a"}}'
    expect(JSON.parse(JSON.stringify(head))).toBe(head)
    expect(assemble([part(0, 2, head), part(1, 2, tail)])).toEqual({
      status: 'complete',
      payload: payloadOf('\u{1f600}')
    })
  })

  it('round-trips an astral payload at every cut parity', () => {
    for (let padding = 0; padding < 4; padding += 1) {
      const payload = payloadOf(`${'x'.repeat(padding)}${'\u{1f600}'.repeat(400_000)}`)
      expect(assemble(framesOf(splitBridgeReply(ID, payload)))).toEqual({
        status: 'complete',
        payload
      })
    }
  })

  it('reassembles frames that arrive out of order', () => {
    const payload = payloadOf('x'.repeat(1_500_000))
    const frames = framesOf(splitBridgeReply(ID, payload))
    expect(assemble(frames.toReversed())).toEqual({ status: 'complete', payload })
  })

  it('keeps two replies apart while both are in flight', () => {
    const first = payloadOf('x'.repeat(1_500_000))
    const second = payloadOf('y'.repeat(1_500_000))
    const firstFrames = framesOf(splitBridgeReply(ID, first))
    const secondFrames = framesOf(splitBridgeReply(OTHER_ID, second))
    const assembler = new BridgeReplyAssembler()
    for (const frame of [...firstFrames.slice(0, -1), ...secondFrames.slice(0, -1)]) {
      expect(assembler.accept(frame)).toEqual({ status: 'pending' })
    }
    expect(assembler.accept(secondFrames[secondFrames.length - 1] ?? part(0, 1, ''))).toEqual({
      status: 'complete',
      payload: second
    })
    expect(assembler.accept(firstFrames[firstFrames.length - 1] ?? part(0, 1, ''))).toEqual({
      status: 'complete',
      payload: first
    })
  })
})

describe('BridgeReplyAssembler refusals', () => {
  it('stays pending while a part is missing', () => {
    const assembler = new BridgeReplyAssembler()
    expect(assembler.accept(part(0, 3, '{"id"'))).toEqual({ status: 'pending' })
    expect(assembler.accept(part(2, 3, '}'))).toEqual({ status: 'pending' })
  })

  it('refuses a part index that arrived already, and drops what it held', () => {
    const assembler = new BridgeReplyAssembler()
    expect(assembler.accept(part(0, 2, 'a'))).toEqual({ status: 'pending' })
    expect(assembler.accept(part(0, 2, 'a'))).toEqual({
      status: 'failed',
      refusal: 'duplicate-part'
    })
    expect(assembler.accept(part(1, 2, 'b'))).toEqual({ status: 'pending' })
  })

  it('refuses a part whose count disagrees with the parts already held', () => {
    const assembler = new BridgeReplyAssembler()
    expect(assembler.accept(part(0, 2, 'a'))).toEqual({ status: 'pending' })
    expect(assembler.accept(part(1, 3, 'b'))).toEqual({
      status: 'failed',
      refusal: 'inconsistent-part'
    })
  })

  it('refuses a part index that is not inside its own count', () => {
    expect(new BridgeReplyAssembler().accept(part(2, 2, 'a'))).toEqual({
      status: 'failed',
      refusal: 'inconsistent-part'
    })
  })

  it('holds no more half-assembled replies than there can be requests in flight', () => {
    const assembler = new BridgeReplyAssembler()
    const idOf = (index: number): string => `id${String(index).padStart(20, '0')}`
    for (let index = 0; index < BRIDGE_MAX_PENDING_REQUESTS; index += 1) {
      expect(assembler.accept(part(0, 2, 'a', idOf(index)))).toEqual({ status: 'pending' })
    }
    const overflowing = idOf(BRIDGE_MAX_PENDING_REQUESTS)
    expect(assembler.accept(part(0, 2, 'a', overflowing))).toEqual({
      status: 'failed',
      refusal: 'too-many-pending'
    })
    // A part for an id already held still lands: the bound is on ids, not on parts.
    expect(assembler.accept(part(1, 2, 'b', idOf(0)))).toEqual({
      status: 'failed',
      refusal: 'malformed-json'
    })
    expect(assembler.accept(part(0, 2, 'a', overflowing))).toEqual({ status: 'pending' })
  })

  it('frees a slot when the page discards an id it abandoned', () => {
    const assembler = new BridgeReplyAssembler()
    const idOf = (index: number): string => `id${String(index).padStart(20, '0')}`
    for (let index = 0; index < BRIDGE_MAX_PENDING_REQUESTS; index += 1) {
      assembler.accept(part(0, 2, 'a', idOf(index)))
    }
    assembler.discard(idOf(3))
    expect(assembler.accept(part(0, 2, 'a', idOf(BRIDGE_MAX_PENDING_REQUESTS)))).toEqual({
      status: 'pending'
    })
  })

  it('accepts parts summing to exactly the ceiling', () => {
    const assembler = new BridgeReplyAssembler()
    const full = 'x'.repeat(BRIDGE_MAX_MESSAGE_BYTES)
    for (let index = 0; index < 12; index += 1) {
      expect(assembler.accept(part(index, 14, full))).toEqual({ status: 'pending' })
    }
    const remaining = BRIDGE_MAX_REPLY_BYTES - 12 * BRIDGE_MAX_MESSAGE_BYTES
    expect(assembler.accept(part(12, 14, 'x'.repeat(remaining)))).toEqual({ status: 'pending' })
  })

  it('aborts one byte past the ceiling', () => {
    const assembler = new BridgeReplyAssembler()
    const full = 'x'.repeat(BRIDGE_MAX_MESSAGE_BYTES)
    for (let index = 0; index < 12; index += 1) {
      assembler.accept(part(index, 14, full))
    }
    const remaining = BRIDGE_MAX_REPLY_BYTES - 12 * BRIDGE_MAX_MESSAGE_BYTES
    expect(assembler.accept(part(12, 14, 'x'.repeat(remaining + 1)))).toEqual({
      status: 'failed',
      refusal: 'reply-too-large'
    })
  })

  it('refuses parts that do not reassemble into JSON', () => {
    const assembler = new BridgeReplyAssembler()
    assembler.accept(part(0, 2, '{"id":'))
    expect(assembler.accept(part(1, 2, 'not json'))).toEqual({
      status: 'failed',
      refusal: 'malformed-json'
    })
  })

  it('refuses parts that reassemble into something that is not a reply', () => {
    const assembler = new BridgeReplyAssembler()
    assembler.accept(part(0, 2, '{"id":"r1",'))
    expect(assembler.accept(part(1, 2, '"ok":true}'))).toEqual({
      status: 'failed',
      refusal: 'unrecognised-message'
    })
  })

  it('drops a half-assembled reply when the whole one arrives instead', () => {
    const assembler = new BridgeReplyAssembler()
    const payload = payloadOf({ ok: 1 })
    assembler.accept(part(0, 2, '{"id":'))
    expect(
      assembler.accept({ v: BRIDGE_PROTOCOL_VERSION, type: 'reply', id: ID, payload })
    ).toEqual({ status: 'complete', payload })
    expect(assembler.accept(part(0, 2, '{"id":'))).toEqual({ status: 'pending' })
  })

  it('forgets a reply the page abandoned', () => {
    const assembler = new BridgeReplyAssembler()
    assembler.accept(part(0, 2, 'a'))
    assembler.discard(ID)
    expect(assembler.accept(part(0, 2, 'a'))).toEqual({ status: 'pending' })
  })

  it('forgets every reply on teardown', () => {
    const assembler = new BridgeReplyAssembler()
    assembler.accept(part(0, 2, 'a'))
    assembler.accept(part(0, 2, 'a', OTHER_ID))
    assembler.clear()
    expect(assembler.accept(part(0, 2, 'a'))).toEqual({ status: 'pending' })
    expect(assembler.accept(part(0, 2, 'a', OTHER_ID))).toEqual({ status: 'pending' })
  })
})
