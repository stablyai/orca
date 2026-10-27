import { describe, expect, it, vi } from 'vitest'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { MAX_TAIL_LINES } from './terminal-tail-limits'
import * as redrawBuffer from './terminal-tail-redraw-buffer'
import { buildRestoredTerminalTailSeed } from './terminal-tail-restore-seed'

// #11315: an SSH TUI (Pi ask_user) repainting full-width rows pinned Electron main at 100% CPU
// because every character written behind the row end rebuilt the whole row string.

const ESC = '\x1b'

// One frame: climb to the top of a three-row panel and overwrite every row in place.
function overwriteFrame(width: number): string {
  return [
    `${ESC}[3A\r${'a'.repeat(width)}\n`,
    `\r${ESC}[5G${'b'.repeat(width)}\n`,
    `\r${'c'.repeat(width)}\n`
  ].join('')
}

function redrawMillis(width: number): number {
  const seed = `${'x'.repeat(width)}\n`.repeat(3)
  let tail = appendNormalizedToTailBuffer([], '', seed, null)
  const chunk = overwriteFrame(width).repeat(36)
  let fastest = Number.POSITIVE_INFINITY
  for (let round = 0; round < 8; round += 1) {
    const started = performance.now()
    tail = appendNormalizedToTailBuffer(tail.lines, tail.partialLine, chunk, tail.redrawCursor)
    fastest = Math.min(fastest, performance.now() - started)
  }
  return fastest
}

// Paint one wide row, then revisit it with cursor-up/newline; `edit` runs before each newline.
function wideRowRevisits(width: number, revisits: number, edit = ''): string {
  return `${ESC}[1A\r${'x'.repeat(width)}\n${`${ESC}[1A${edit}\n`.repeat(revisits)}`
}

// Each join of a row-sized cell array is an O(width) rebuild.
function countWideJoins(width: number, run: () => void): number {
  const join = vi.spyOn(Array.prototype, 'join')
  try {
    run()
    return join.mock.contexts.filter((cells) => Array.isArray(cells) && cells.length >= width)
      .length
  } finally {
    join.mockRestore()
  }
}

describe('terminal tail redraw cost', () => {
  it('keeps the overwritten rows exact', () => {
    const width = 40
    const seed = appendNormalizedToTailBuffer([], '', `${'x'.repeat(width)}\n`.repeat(3), null)
    const next = appendNormalizedToTailBuffer(
      seed.lines,
      seed.partialLine,
      overwriteFrame(width).repeat(2),
      seed.redrawCursor
    )
    expect(next.lines.slice(-3)).toEqual([
      'a'.repeat(width),
      `    ${'b'.repeat(width)}`,
      'c'.repeat(width)
    ])
  })

  it('grows linearly with row width when a TUI overwrites full rows in place', () => {
    // Warm both sizes so JIT tiering does not land on one side of the ratio.
    redrawMillis(1000)
    redrawMillis(8000)
    const narrow = redrawMillis(1000)
    const wide = redrawMillis(8000)
    // 8x the width is ~8x the bytes; the per-character row rebuild made this ~64x.
    expect(wide / narrow).toBeLessThan(24)
  })

  it('windows a multi-frame chunk by the net cursor reach, not the summed cursor-ups', () => {
    const history = Array.from({ length: MAX_TAIL_LINES }, (_, index) => `history ${index}`)
    const panelRows = 40
    const frame = `${ESC}[${panelRows}A${Array.from(
      { length: panelRows },
      (_, row) => `\r${ESC}[2Kchoice ${row}\n`
    ).join('')}`
    const unwindowed = vi.spyOn(redrawBuffer, 'appendNormalizedToMultilineTailBufferUnwindowed')
    try {
      // 60 frames climb 2400 rows in total but never more than one panel above the end.
      appendNormalizedToTailBuffer(history, '', frame.repeat(60), null)
      expect(unwindowed).toHaveBeenCalledTimes(1)
      expect(unwindowed.mock.calls[0]![0].length).toBeLessThan(panelRows * 2)
    } finally {
      unwindowed.mockRestore()
    }
  })

  it('keeps only the newest MAX_TAIL_LINES rows when one chunk replays a long history', () => {
    const history = Array.from({ length: MAX_TAIL_LINES }, (_, index) => `history ${index}`)
    // A full-screen TUI redraw replays every line it has ever printed in one write.
    const replay = Array.from({ length: 20_000 }, (_, index) => `replayed ${index}\n`).join('')
    const next = appendNormalizedToTailBuffer(history, '', replay, { rowFromEnd: 3, column: 0 })
    expect(next.lines).toHaveLength(MAX_TAIL_LINES)
    expect(next.lines.at(-1)).toBe('replayed 19999')
    expect(next.truncated).toBe(true)
  })

  it('does not rebuild an unchanged wide row on every cursor-up/newline revisit', () => {
    const width = 32_000
    let tail: ReturnType<typeof appendNormalizedToTailBuffer> | undefined
    const joins = countWideJoins(width, () => {
      tail = appendNormalizedToTailBuffer([], '', wideRowRevisits(width, 4_000), null)
    })
    expect(joins).toBe(0)
    expect(tail?.lines).toEqual(['x'.repeat(width)])
  })

  it('never joins a wide row when every revisit repeats the same one-cell edit', () => {
    const width = 64_000
    let tail: ReturnType<typeof appendNormalizedToTailBuffer> | undefined
    const joins = countWideJoins(width, () => {
      tail = appendNormalizedToTailBuffer([], '', wideRowRevisits(width, 2_000, '\ry'), null)
    })
    expect(joins).toBe(0)
    expect(tail?.lines).toEqual([`y${'x'.repeat(width - 1)}`])
  })

  it('seeds a restored tail without rebuilding a revisited wide row', () => {
    const width = 32_000
    let seedLines: string[] | undefined
    const joins = countWideJoins(width, () => {
      seedLines = buildRestoredTerminalTailSeed(wideRowRevisits(width, 4_000))?.lines
    })
    expect(joins).toBe(0)
    expect(seedLines).toEqual(['x'.repeat(width)])
  })
})
