import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import { BridgeTerminalOutputBacklog } from './bridge-terminal-output-backlog'

type Output = { type: 'data'; streamId: number; chunk: string }
type Metadata = { type: 'resized'; streamId: number; cols: number; rows: number }
type Payload = Output | Metadata

function output(chunk: string, streamId = 1): Output {
  return { type: 'data', streamId, chunk }
}

function wireBytes(payload: Payload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8')
}

function createBacklog(): BridgeTerminalOutputBacklog {
  return new BridgeTerminalOutputBacklog({
    onAckSilence: () => {
      throw new Error('Unexpected acknowledgement timeout')
    },
    timers: { set: () => 1, clear: () => undefined }
  })
}

function drain(payloads: readonly Payload[], cap: number, windowEmpty: boolean): unknown[] {
  const backlog = createBacklog()
  const frames: unknown[] = []
  try {
    for (const payload of payloads) {
      expect(backlog.hold(payload)).toBe(true)
    }
    while (backlog.held) {
      const frame = backlog.next(cap, windowEmpty)
      if (frame === null) {
        break
      }
      frames.push(frame)
    }
    return frames
  } finally {
    backlog.dispose()
  }
}

// The wire serializer is the oracle for both escaping and the exact accepted prefix.
function serializedFrames(
  payloads: readonly Payload[],
  cap: number,
  windowEmpty: boolean
): Payload[] {
  const pending = [...payloads]
  const frames: Payload[] = []
  while (pending.length > 0) {
    const head = pending[0]
    if (wireBytes(head) > cap && !windowEmpty) {
      break
    }
    pending.shift()
    if (head.type !== 'data') {
      frames.push(head)
      continue
    }
    let frame = head
    while (pending[0]?.type === 'data') {
      const next = pending[0]
      const combined = output(frame.chunk + next.chunk, head.streamId)
      if (wireBytes(combined) > cap) {
        break
      }
      pending.shift()
      frame = combined
    }
    frames.push(frame)
  }
  return frames
}

describe('terminal backlog merge framing', () => {
  it('merges split surrogate pairs across empty chunks at the exact byte cap', () => {
    const payloads = [output('prefix\ud83d'), output(''), output(''), output('\ude00suffix')]
    const combined = output('prefix😀suffix')
    const cap = wireBytes(combined)
    expect(drain(payloads, cap, true)).toEqual([combined])
    expect(drain(payloads, cap - 1, true)).toEqual(serializedFrames(payloads, cap - 1, true))
  })
})
