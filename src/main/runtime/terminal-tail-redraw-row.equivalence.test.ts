import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../shared/agent-tui-ansi-fuzz-stream'

import { appendNormalizedToMultilineTailBufferUnwindowed } from './terminal-tail-redraw-buffer'
import { appendPerCharacterRedrawReference } from './terminal-tail-per-character-redraw.test-fixture'

describe('retained terminal row equivalence', () => {
  it('matches the per-character redraw model across 2,000 randomized chunk streams', () => {
    const rng = mulberry32(0x263160)
    const pick = <T>(items: T[]): T => items[Math.floor(rng() * items.length)]!
    const tokens: (() => string)[] = [
      () => 'abc y'.slice(0, 1 + Math.floor(rng() * 5)),
      () => 'x'.repeat(Math.floor(rng() * 300)),
      () => pick([' ', '\t']).repeat(Math.floor(rng() * 200)),
      () => pick(['\n', '\r', '\b', '\r\n']),
      () => `\x1b[${pick(['', '1', '2', '3'])}A`,
      () => `\x1b[${pick(['', '0', '1', '2', '3'])}K`,
      () => `\x1b[${Math.floor(rng() * 400)}${pick(['G', 'C', 'D'])}`,
      () => `\x1b[1A\r${pick(['y', 'y'.repeat(33), 'panel'])}\n`
    ]
    type TailState = ReturnType<typeof appendNormalizedToMultilineTailBufferUnwindowed>
    const advance = (
      model: typeof appendPerCharacterRedrawReference,
      state: TailState,
      chunk: string
    ): TailState => model(state.lines, state.partialLine, chunk, false, state.redrawCursor)
    for (let stream = 0; stream < 2_000; stream += 1) {
      const empty: TailState = {
        lines: [],
        partialLine: '',
        redrawCursor: null,
        truncated: false,
        newCompleteLines: 0,
        newlyCompletedLines: []
      }
      let current = empty
      let reference = empty
      for (let chunkIndex = 0; chunkIndex < 6; chunkIndex += 1) {
        let chunk = ''
        const count = Math.floor(rng() * 40)
        for (let token = 0; token < count; token += 1) {
          chunk += pick(tokens)()
        }
        current = advance(appendNormalizedToMultilineTailBufferUnwindowed, current, chunk)
        reference = advance(appendPerCharacterRedrawReference, reference, chunk)
        expect(current, `stream ${stream} chunk ${chunkIndex}`).toEqual(reference)
      }
    }
  })
})
