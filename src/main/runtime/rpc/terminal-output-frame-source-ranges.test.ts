import { describe, expect, it } from 'vitest'
import { TERMINAL_STREAM_CHUNK_BYTES } from '../../../shared/terminal-multiplex-flow-control'
import type { TerminalOutputSourceRange } from '../../../shared/terminal-output-source-range'
import { iterateTerminalOutputFrameChunks } from './terminal-output-frame-chunks'

function range(overrides: Partial<TerminalOutputSourceRange>): TerminalOutputSourceRange {
  return {
    id: 'pty-1',
    spanId: 'span-1',
    providerGeneration: 2,
    clientGeneration: 3,
    ownerGeneration: 4,
    ptyIncarnation: 'incarnation-1',
    deliveryToken: 'token-1',
    sourceStartSu: 0,
    sourceEndSu: 1,
    displayStart: 0,
    displayEnd: 1,
    splittable: true,
    transform: { transformed: false, rawLengthSu: 1, scalarSafe: true },
    ...overrides
  }
}

describe('terminal output frame source ranges', () => {
  it('maps encoded chunk boundaries to exact ordered source subranges', () => {
    const data = 'a'.repeat(TERMINAL_STREAM_CHUNK_BYTES + 2)
    const frames = Array.from(
      iterateTerminalOutputFrameChunks(data, {
        seq: data.length,
        rawLength: data.length,
        sourceRanges: [
          range({
            sourceEndSu: TERMINAL_STREAM_CHUNK_BYTES - 1,
            displayEnd: TERMINAL_STREAM_CHUNK_BYTES - 1,
            transform: {
              transformed: false,
              rawLengthSu: TERMINAL_STREAM_CHUNK_BYTES - 1,
              scalarSafe: true
            }
          }),
          range({
            spanId: 'span-2',
            sourceStartSu: TERMINAL_STREAM_CHUNK_BYTES - 1,
            sourceEndSu: data.length,
            displayStart: TERMINAL_STREAM_CHUNK_BYTES - 1,
            displayEnd: data.length,
            transform: {
              transformed: false,
              rawLengthSu: data.length - TERMINAL_STREAM_CHUNK_BYTES + 1,
              scalarSafe: true
            }
          })
        ]
      })
    )

    expect(frames).toHaveLength(2)
    expect(frames[0]?.sourceRanges).toEqual([
      expect.objectContaining({
        spanId: 'span-1',
        sourceStartSu: 0,
        sourceEndSu: TERMINAL_STREAM_CHUNK_BYTES - 1
      }),
      expect.objectContaining({
        spanId: 'span-2',
        sourceStartSu: TERMINAL_STREAM_CHUNK_BYTES - 1,
        sourceEndSu: TERMINAL_STREAM_CHUNK_BYTES
      })
    ])
    expect(frames[1]?.sourceRanges).toEqual([
      expect.objectContaining({
        spanId: 'span-2',
        sourceStartSu: TERMINAL_STREAM_CHUNK_BYTES,
        sourceEndSu: data.length
      })
    ])
  })

  it('keeps transformed source ranges indivisible', () => {
    const sourceRange = range({
      sourceEndSu: 9,
      displayEnd: 3,
      splittable: false,
      transform: { transformed: true, rawLengthSu: 9, scalarSafe: false }
    })
    const [frame] = iterateTerminalOutputFrameChunks('xyz', {
      seq: 9,
      rawLength: 9,
      transformed: true,
      sourceRanges: [sourceRange]
    })

    expect(frame?.sourceRanges).toEqual([sourceRange])
  })
})
