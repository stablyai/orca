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

describe('terminal backlog merge framing', () => {
  it('merges split surrogate pairs across empty chunks at the exact byte cap', () => {
    const payloads = [output('prefix\ud83d'), output(''), output(''), output('\ude00suffix')]
    const combined = output('prefix😀suffix')
    const cap = wireBytes(combined)
    expect(drain(payloads, cap, true)).toEqual([combined])
  })
})
