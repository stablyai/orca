import { describe, expect, it } from 'vitest'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'

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
})
