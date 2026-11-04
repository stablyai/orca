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

function requiredLast(frames: BridgeReplyMessage[]): BridgeReplyMessage {
  const frame = frames.at(-1)
  if (frame === undefined) {
    throw new Error('splitter emitted no final frame')
  }
  return frame
}

function checkedParts(chunks: string[], id = ID, missing = 0): BridgeReplyMessage[] {
  return chunks.map((chunk, i) => {
    const frame = part(i, chunks.length + missing, chunk, id)
    const raw = JSON.stringify(frame)
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(BRIDGE_MAX_MESSAGE_BYTES)
    expect(readBridgeHostMessage(raw).ok).toBe(true)
    return frame
  })
}

function asciiParts(bytes: number, id = ID): BridgeReplyMessage[] {
  const chunks: string[] = []
  const size = BRIDGE_MAX_MESSAGE_BYTES - 512
  for (let offset = 0; offset < bytes; offset += size) {
    chunks.push('x'.repeat(Math.min(size, bytes - offset)))
  }
  return checkedParts(chunks, id, 1)
}

function splitInsidePair(extra = ''): BridgeReplyMessage[] {
  const chunks = framesOf(splitBridgeReply(ID, ceilingPayload())).flatMap((frame) => {
    if (!('chunk' in frame)) {
      throw new Error('ceiling reply was not chunked')
    }
    return [frame.chunk]
  })
  const first = chunks.shift()
  if (first === undefined) {
    throw new Error('no first chunk')
  }
  const cut = first.indexOf(ASTRAL) + 1
  expect(cut).toBeGreaterThan(0)
  return checkedParts([
    first.slice(0, cut),
    first.slice(cut, cut + 1) + extra,
    first.slice(cut + 1),
    ...chunks
  ])
}

const ASTRAL = String.fromCodePoint(0x1f600)
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd800)

function ceilingPayload(): BridgeReplyPayload {
  const overhead = JSON.stringify(payloadOf('')).length
  const pairs = Math.floor((BRIDGE_MAX_REPLY_BYTES - overhead) / 4)
  const padding = BRIDGE_MAX_REPLY_BYTES - overhead - pairs * 4
  return payloadOf(ASTRAL.repeat(pairs) + 'x'.repeat(padding))
}

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
    // Use maximum-size fully re-escaped content to prove every accepted reply stays below the part-count ceiling.
    const empty = payloadOf('')
    const backslashes = Math.floor((BRIDGE_MAX_REPLY_BYTES - JSON.stringify(empty).length) / 2)
    const payload = payloadOf('\\'.repeat(backslashes))
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(
      BRIDGE_MAX_REPLY_BYTES
    )
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeGreaterThan(
      BRIDGE_MAX_REPLY_BYTES - 4
    )
    const frames = framesOf(splitBridgeReply(ID, payload))
    expect(BRIDGE_MAX_REPLY_PARTS).toBeGreaterThan(frames.length)
    for (const frame of frames) {
      expect(utf8ByteLength(JSON.stringify(frame))).toBeLessThanOrEqual(BRIDGE_MAX_MESSAGE_BYTES)
      expect(readBridgeHostMessage(JSON.stringify(frame)).ok).toBe(true)
    }
    expect(assemble(frames)).toEqual({ status: 'complete', payload })
  })

  it('never cuts a frame inside a surrogate pair, at any cut parity', () => {
    for (let padding = 0; padding < 4; padding += 1) {
      const payload = payloadOf(`${'x'.repeat(padding)}${ASTRAL.repeat(1_000_000)}`)
      const frames = framesOf(splitBridgeReply(ID, payload))
      expect(assemble(frames)).toEqual({ status: 'complete', payload })
      expect(frames.length).toBeGreaterThan(2)
      for (const frame of frames) {
        const chunk = 'part' in frame ? frame.chunk : ''
        const first = chunk.charCodeAt(0)
        const last = chunk.charCodeAt(chunk.length - 1)
        expect([
          padding,
          first >= 0xdc00 && first <= 0xdfff,
          last >= 0xd800 && last <= 0xdbff
        ]).toEqual([padding, false, false])
      }
    }
  })

  it('round-trips a reply of exactly the ceiling, cuts and all', () => {
    const payload = ceilingPayload()
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBe(
      BRIDGE_MAX_REPLY_BYTES
    )
    expect(assemble(framesOf(splitBridgeReply(ID, payload)))).toEqual({
      status: 'complete',
      payload
    })
  })

  it('refuses a lone-surrogate reply over the ceiling rather than splitting it', () => {
    const payload = payloadOf(LONE_HIGH_SURROGATE.repeat(BRIDGE_MAX_REPLY_BYTES / 6))
    expect(splitBridgeReply(ID, payload)).toEqual({ ok: false, refusal: 'reply-too-large' })
  })

  it('round-trips lone surrogates that fit', () => {
    const payload = payloadOf(LONE_HIGH_SURROGATE.repeat(200_000))
    expect(assemble(framesOf(splitBridgeReply(ID, payload)))).toEqual({
      status: 'complete',
      payload
    })
  })

  it('refuses a reply over the ceiling instead of chunking it forever', () => {
    const oversized = payloadOf('x'.repeat(BRIDGE_MAX_REPLY_BYTES + 1))
    expect(splitBridgeReply(ID, oversized)).toEqual({ ok: false, refusal: 'reply-too-large' })
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
      const frames = framesOf(splitBridgeReply(ID, payload))
      expect(frames.length).toBeLessThanOrEqual(BRIDGE_MAX_REPLY_PARTS)
      for (const frame of frames) {
        const raw = JSON.stringify(frame)
        expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(
          BRIDGE_MAX_MESSAGE_BYTES
        )
        expect(readBridgeHostMessage(raw).ok).toBe(true)
      }
      expect(assemble(frames)).toEqual({
        status: 'complete',
        payload
      })
    })
  }

  it('restores a surrogate pair that was cut in half between two frames', () => {
    // JSON escapes lone surrogate halves; joining the decoded parts must restore the original pair.
    const head = '{"id":"r1","ok":true,"result":"\ud83d'
    const tail = '\ude00","_meta":{"runtimeId":"runtime-a"}}'
    expect(JSON.parse(JSON.stringify(head))).toBe(head)
    expect(assemble([part(0, 2, head), part(1, 2, tail)])).toEqual({
      status: 'complete',
      payload: payloadOf('\u{1f600}')
    })
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
    expect(assembler.accept(requiredLast(secondFrames))).toEqual({
      status: 'complete',
      payload: second
    })
    expect(assembler.accept(requiredLast(firstFrames))).toEqual({
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
  })

  it('keeps a refused id refused, so a sender cannot start over on the next part', () => {
    const assembler = new BridgeReplyAssembler()
    assembler.accept(part(0, 3, '{"id"'))
    expect(assembler.accept(part(0, 3, '{"id"'))).toEqual({
      status: 'failed',
      refusal: 'duplicate-part'
    })
    const payload = payloadOf('small')
    const serialized = JSON.stringify(payload)
    const size = Math.ceil(serialized.length / 3)
    const frames = checkedParts([
      serialized.slice(0, size),
      serialized.slice(size, size * 2),
      serialized.slice(size * 2)
    ])
    expect(assemble(frames)).toEqual({ status: 'complete', payload })
    for (const frame of frames) {
      expect(assembler.accept(frame)).toEqual({
        status: 'failed',
        refusal: 'duplicate-part'
      })
    }
    expect(
      assembler.accept({ v: BRIDGE_PROTOCOL_VERSION, type: 'reply', id: ID, payload })
    ).toEqual({ status: 'failed', refusal: 'duplicate-part' })
    assembler.discard(ID)
    expect(assembler.accept(part(0, 3, '{"id"'))).toEqual({ status: 'pending' })
  })

  it('refuses every later part of a reply that went past the ceiling', () => {
    const assembler = new BridgeReplyAssembler()
    const frames = asciiParts(BRIDGE_MAX_REPLY_BYTES + 1)
    for (const frame of frames.slice(0, -1)) {
      expect(assembler.accept(frame)).toEqual({ status: 'pending' })
    }
    expect(assembler.accept(requiredLast(frames))).toEqual({
      status: 'failed',
      refusal: 'reply-too-large'
    })
    for (const frame of checkedParts(['new', 'reply'])) {
      expect(assembler.accept(frame)).toEqual({ status: 'failed', refusal: 'reply-too-large' })
    }
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
    expect(assembler.accept(part(1, 2, 'b', idOf(0)))).toEqual({
      status: 'failed',
      refusal: 'malformed-json'
    })
    assembler.discard(overflowing)
    expect(assembler.accept(part(0, 2, 'a', overflowing))).toEqual({ status: 'pending' })
  })

  it('refuses the part that would push every reply in flight past the aggregate', () => {
    const assembler = new BridgeReplyAssembler()
    const idOf = (index: number) => `id${String(index).padStart(20, '0')}`
    let heldParts = 0
    for (let id = 0; id < 4; id += 1) {
      const frames = asciiParts(BRIDGE_MAX_REPLY_BYTES, idOf(id))
      heldParts = frames.length
      for (const frame of frames) {
        expect(assembler.accept(frame)).toEqual({ status: 'pending' })
      }
    }
    expect(assembler.accept(part(0, 2, 'x', idOf(4)))).toEqual({
      status: 'failed',
      refusal: 'too-many-pending'
    })
    expect(assembler.accept(part(heldParts, heldParts + 1, 'x', idOf(0)))).toEqual({
      status: 'failed',
      refusal: 'too-many-pending'
    })
  })

  it('forgets every refusal when it is cleared for teardown', () => {
    const assembler = new BridgeReplyAssembler()
    assembler.accept(part(0, 2, 'a'))
    expect(assembler.accept(part(0, 2, 'a'))).toEqual({
      status: 'failed',
      refusal: 'duplicate-part'
    })
    assembler.clear()
    expect(assembler.accept(part(0, 2, 'a'))).toEqual({ status: 'pending' })
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

  it('measures joined UTF8 bytes when a surrogate pair crosses parts', () => {
    const payload = ceilingPayload()
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBe(
      BRIDGE_MAX_REPLY_BYTES
    )
    expect(assemble(splitInsidePair())).toEqual({ status: 'complete', payload })
  })

  it('refuses a joined reply past the ceiling whose code units still fit', () => {
    const frames = splitInsidePair(ASTRAL)
    const joined = frames.map((frame) => ('chunk' in frame ? frame.chunk : '')).join('')
    expect(joined.length).toBeLessThanOrEqual(BRIDGE_MAX_REPLY_BYTES)
    expect(new TextEncoder().encode(joined).byteLength).toBeGreaterThan(BRIDGE_MAX_REPLY_BYTES)
    expect(assemble(frames)).toEqual({ status: 'failed', refusal: 'reply-too-large' })
  })

  it('retains incomplete ASCII parts totaling exactly the reply ceiling', () => {
    const assembler = new BridgeReplyAssembler()
    for (const frame of asciiParts(BRIDGE_MAX_REPLY_BYTES)) {
      expect(assembler.accept(frame)).toEqual({ status: 'pending' })
    }
  })

  it('aborts incomplete ASCII parts one byte past the reply ceiling', () => {
    const assembler = new BridgeReplyAssembler()
    const frames = asciiParts(BRIDGE_MAX_REPLY_BYTES + 1)
    for (const frame of frames.slice(0, -1)) {
      expect(assembler.accept(frame)).toEqual({ status: 'pending' })
    }
    expect(assembler.accept(requiredLast(frames))).toEqual({
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
