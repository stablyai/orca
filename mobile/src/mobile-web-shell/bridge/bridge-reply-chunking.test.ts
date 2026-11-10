import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES, BRIDGE_MAX_REPLY_BYTES } from './bridge-caps'
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

function payloadOf(result: unknown): BridgeReplyPayload {
  return { id: 'r1', ok: true, result, _meta: { runtimeId: 'runtime-a' } }
}

function part(i: number, of: number, chunk: string, id = ID): BridgeReplyMessage {
  return { v: BRIDGE_PROTOCOL_VERSION, type: 'reply', id, part: { i, of }, chunk }
}

function rawFramesOf(split: BridgeReplySplit): string[] {
  if (!split.ok) {
    throw new Error(`expected a split, got ${split.refusal}`)
  }
  return split.frames
}

// Read frames with the page's reader, so a frame it would refuse fails the test.
function framesOf(split: BridgeReplySplit): BridgeReplyMessage[] {
  return rawFramesOf(split).map((raw) => {
    const read = readBridgeHostMessage(raw)
    if (!read.ok || read.message.type !== 'reply') {
      throw new Error('the page would not read this frame as a reply')
    }
    return read.message
  })
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
})

describe('round trip', () => {
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
})
