import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import * as byteCounter from '../../../src/shared/terminal-stream-json-byte-length'
import {
  BridgeTerminalOutputBacklog,
  terminalStreamMaxPayloadBytes
} from './bridge-terminal-output-backlog'

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
  it.each([Number.NaN, Infinity, -Infinity, -0, 0, 1, 123_456, 1e21])(
    'matches the serializer with mixed numeric stream ids, including %s',
    (streamId) => {
      const payloads = [output('first', streamId), output('second', 99), output('third', -0)]
      for (const cap of [0, wireBytes(payloads[0]), 54, 80, 120]) {
        for (const windowEmpty of [false, true]) {
          expect(drain(payloads, cap, windowEmpty)).toEqual(
            serializedFrames(payloads, cap, windowEmpty)
          )
        }
      }
    }
  )

  it('merges split surrogate pairs across empty chunks at the exact byte cap', () => {
    const payloads = [output('prefix\ud83d'), output(''), output(''), output('\ude00suffix')]
    const combined = output('prefix😀suffix')
    const cap = wireBytes(combined)
    expect(drain(payloads, cap, true)).toEqual([combined])
    expect(drain(payloads, cap - 1, true)).toEqual(serializedFrames(payloads, cap - 1, true))
  })

  it('preserves escaped controls, quotes, backslashes, Unicode and lone surrogates', () => {
    const payloads = [
      output('\u001b[31m\b\t\n\f\r\u0000'),
      output('"\\café漢字😀'),
      output('\ud800'),
      output(''),
      output('x\udc00'),
      output('\ud800\ud800'),
      output('\udc00\udc00')
    ]
    for (let cap = 0; cap < 180; cap++) {
      expect(drain(payloads, cap, true)).toEqual(serializedFrames(payloads, cap, true))
    }
  })

  it('keeps metadata barriers and oversized-head behavior in either window state', () => {
    const payloads: Payload[] = [
      output('before'),
      { type: 'resized', streamId: 1, cols: 80, rows: 24 },
      output('x'.repeat(1000)),
      output(''),
      output('after')
    ]
    for (const windowEmpty of [false, true]) {
      expect(drain(payloads, 100, windowEmpty)).toEqual(
        serializedFrames(payloads, 100, windowEmpty)
      )
    }
  })

  it('matches serialized frame boundaries on fragmented mixed output', () => {
    const cells = ['plain', '\u001b[31m', '\n', '"\\', '漢字', '\ud83d', '', '\ude00', '\ud800']
    const payloads: Payload[] = []
    for (let index = 0; index < 300; index++) {
      payloads.push(output(cells[index % cells.length], index % 11 === 0 ? Number.NaN : index))
      if (index % 37 === 0) {
        payloads.push({ type: 'resized', streamId: index, cols: 80, rows: 24 })
      }
    }
    for (const cap of [38, 50, 80, 640, 4096]) {
      for (const windowEmpty of [false, true]) {
        expect(drain(payloads, cap, windowEmpty)).toEqual(
          serializedFrames(payloads, cap, windowEmpty)
        )
      }
    }
  })

  it('counts fragmented output once instead of rescanning growing temporary strings', () => {
    const chunks = Array.from({ length: 256 }, (_, index) => String(index).padEnd(1024, 'x'))
    const measured = vi.spyOn(byteCounter, 'terminalStreamJsonByteLength')
    try {
      const frames = drain(
        chunks.map((chunk) => output(chunk)),
        terminalStreamMaxPayloadBytes('id'),
        true
      )
      expect(frames).toEqual([output(chunks.join(''))])
      const measuredUnits = measured.mock.calls.reduce((sum, [chunk]) => sum + chunk.length, 0)
      expect(measuredUnits).toBeLessThanOrEqual(chunks.join('').length * 2)
    } finally {
      measured.mockRestore()
    }
  })
})
