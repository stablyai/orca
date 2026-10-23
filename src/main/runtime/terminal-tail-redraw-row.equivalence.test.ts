import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../shared/agent-tui-ansi-fuzz-stream'
import {
  eraseRetainedRow,
  retainedRow,
  retainedRowSnapshot,
  writeRetainedRow
} from './terminal-tail-redraw-row'
import { appendNormalizedToMultilineTailBufferUnwindowed } from './terminal-tail-redraw-buffer'
import { appendPerCharacterRedrawReference } from './terminal-tail-per-character-redraw.test-fixture'

// Differential guard: the cached string/cell row must match the original one-character-at-a-time
// string row on every write, erase, and newline snapshot, including identical rewrites and
// trailing spaces/tabs.

/** The pre-cache row semantics: per-character string writes. */
class ReferenceRow {
  constructor(public text: string) {}

  write(column: number, run: string): void {
    for (const char of run.split('')) {
      if (column > this.text.length) {
        this.text += ' '.repeat(column - this.text.length)
      }
      this.text =
        column >= this.text.length
          ? `${this.text}${char}`
          : `${this.text.slice(0, column)}${char}${this.text.slice(column + 1)}`
      column += 1
    }
  }

  erase(mode: number, column: number): void {
    if (mode === 0) {
      this.text = this.text.slice(0, column)
    } else if (mode === 1) {
      const count = Math.min(column + 1, this.text.length)
      this.text = `${' '.repeat(count)}${this.text.slice(count)}`
    } else if (mode === 2) {
      this.text = ''
    }
  }

  snapshot(): string {
    return this.text.replace(/[ \t]+$/, '')
  }
}

function randomRun(rng: () => number, reference: string, column: number): string {
  const roll = rng()
  const length = 1 + Math.floor(rng() * 12)
  if (roll < 0.3 && column < reference.length) {
    // Identical rewrite, sometimes running past the row end.
    return reference.slice(column, column + length) || 'z'
  }
  const alphabet = roll < 0.6 ? ' \t' : 'ab \ty'
  let run = ''
  for (let index = 0; index < length; index += 1) {
    run += alphabet[Math.floor(rng() * alphabet.length)]
  }
  return run
}

function randomInitialRow(rng: () => number): string {
  const kinds = ['', 'panel', 'x'.repeat(30), `panel${' '.repeat(40)}`, `a\t \t${'\t'.repeat(9)}`]
  return kinds[Math.floor(rng() * kinds.length)]!
}

describe('retained terminal row equivalence', () => {
  it('matches per-character string rows across 3,000 randomized edit sequences', () => {
    const rng = mulberry32(0x26316)
    for (let sequence = 0; sequence < 3_000; sequence += 1) {
      const initial = randomInitialRow(rng)
      const row = retainedRow(initial, true)
      const reference = new ReferenceRow(initial)
      const ops: string[] = []
      for (let step = 0; step < 24; step += 1) {
        const width = reference.text.length
        const column = Math.floor(rng() * (width + 6))
        const roll = rng()
        if (roll < 0.55) {
          const run = randomRun(rng, reference.text, column)
          ops.push(`w${column}:${JSON.stringify(run)}`)
          reference.write(column, run)
          writeRetainedRow(row, column, `<${run}>`, 1, run.length + 1)
        } else if (roll < 0.75) {
          const mode = Math.floor(rng() * 4)
          ops.push(`e${mode}@${column}`)
          reference.erase(mode, column)
          eraseRetainedRow(row, mode, column)
        }
        // Newline snapshots interleave with edits, so cached snapshots must invalidate exactly.
        if (rng() < 0.5) {
          expect(retainedRowSnapshot(row), `${JSON.stringify(initial)} ${ops.join(' ')}`).toBe(
            reference.snapshot()
          )
        }
      }
      expect(retainedRowSnapshot(row), `${JSON.stringify(initial)} ${ops.join(' ')}`).toBe(
        reference.snapshot()
      )
    }
  })

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
