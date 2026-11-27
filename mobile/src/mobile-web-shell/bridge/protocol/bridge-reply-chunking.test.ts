import { describe, expect, it } from 'vitest'

import {
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

const ASTRAL = String.fromCodePoint(0x1f600)

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
