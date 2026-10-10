import { describe, expect, it, vi } from 'vitest'
import * as ownership from '../../shared/own-retained-string'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴']

/** A Claude Code / Codex spinner chunk: many CR-redraw frames, then one completed line. */
function spinnerChunk(index: number, chunkChars: number): string {
  const parts: string[] = []
  let length = 0
  let frame = 0
  while (length < chunkChars - 64) {
    const piece = `\r${SPINNER[frame % SPINNER.length]} Thinking... (${frame}s) esc to interrupt`
    parts.push(piece)
    length += piece.length
    frame += 1
  }
  parts.push(`\rstep ${index} done\n`)
  return parts.join('')
}

function collectHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) {
    throw new Error('global.gc unavailable - config/vitest.config.ts must pass --expose-gc')
  }
  void /reset/.test('reset')
  gc()
  gc()
  return process.memoryUsage().heapUsed
}

describe('retained terminal tail row storage', () => {
  it('does not pin one chunk per retained row across a spinner workload', () => {
    let lines: string[] = []
    let partialLine = ''
    for (let index = 0; index < 4; index += 1) {
      const warm = appendNormalizedToTailBuffer(lines, partialLine, spinnerChunk(index, 4096))
      lines = warm.lines
      partialLine = warm.partialLine
    }

    lines = []
    partialLine = ''
    const chunkChars = 64 * 1024
    const chunkCount = 200
    const before = collectHeap()
    // Why build each chunk inside the loop: a pre-built array would pin every chunk itself.
    for (let index = 0; index < chunkCount; index += 1) {
      const next = appendNormalizedToTailBuffer(lines, partialLine, spinnerChunk(index, chunkChars))
      lines = next.lines
      partialLine = next.partialLine
    }
    const retained = collectHeap() - before

    expect(lines).toHaveLength(chunkCount)
    const tailChars = lines.reduce((sum, line) => sum + line.length, 0) + partialLine.length
    expect(tailChars).toBeLessThan(8 * 1024)
    // Un-owned, each of the 200 rows pins its own 64 Ki chunk: about 25 MB.
    expect(retained).toBeLessThan(4 * 1024 * 1024)
    expect(lines.at(-1)).toBe(`step ${chunkCount - 1} done`)
  })

  it('does not pin a padded redraw row behind its trimmed text', () => {
    let tail = appendNormalizedToTailBuffer([], '', 'warm\n')
    const before = collectHeap()
    for (let index = 0; index < 250; index += 1) {
      const text = `\x1b[0Arow-${String(index).padStart(5, '0')}-completed${' '.repeat(64_000)}\n`
      tail = appendNormalizedToTailBuffer(tail.lines, tail.partialLine, text, tail.redrawCursor)
    }
    const retained = collectHeap() - before

    expect(tail.lines.at(-1)).toBe('row-00249-completed')
    // Sliced from the padded row, 250 short lines pinned about 16 MB.
    expect(retained).toBeLessThan(4 * 1024 * 1024)
  })

  it.each([
    ['half', 0.5],
    ['quarter', 0.75]
  ])('does not pin a 64 KiB row that chained erases shrink by a %s at a time', (_, ratio) => {
    const shrinkChunk = (index: number): string => {
      const char = String.fromCharCode(65 + (index % 26))
      let chunk = `\x1b[0A${char.repeat(65_536)}`
      // Each \r + identical prefix + CSI K keeps at least half of the current row.
      for (let keep = Math.floor(65_536 * ratio); keep >= 16; keep = Math.floor(keep * ratio)) {
        chunk += `\r${char.repeat(keep)}\x1b[K`
      }
      return `${chunk}\n`
    }
    let lines = appendNormalizedToTailBuffer([], '', shrinkChunk(0)).lines
    const before = collectHeap()
    for (let index = 1; index <= 200; index += 1) {
      lines = appendNormalizedToTailBuffer(lines, '', shrinkChunk(index)).lines
    }
    const retained = collectHeap() - before

    expect(lines.at(-1)).toMatch(/^[A-Z]{1,20}$/)
    // Nested slices pinned each completed row's 64 KiB original: about 13 MB.
    expect(retained).toBeLessThan(4 * 1024 * 1024)
  })

  it('routes every retained row and partial line through ownRetainedString', () => {
    const own = vi.spyOn(ownership, 'ownRetainedString')
    try {
      const chunk = `${'x'.repeat(16 * 1024)}\nsecond line\ntrailing partial`
      const result = appendNormalizedToTailBuffer([], '', chunk)

      expect(result.lines).toEqual(['x'.repeat(16 * 1024), 'second line'])
      expect(result.partialLine).toBe('trailing partial')
      expect(own.mock.calls.map(([value]) => value)).toEqual([
        'x'.repeat(16 * 1024),
        'second line',
        'trailing partial'
      ])
    } finally {
      own.mockRestore()
    }
  })

  it('does not pin overwritten multiline redraw chunks through completed rows', () => {
    let lines: string[] = []
    const before = collectHeap()
    for (let index = 0; index < 200; index += 1) {
      const chunk = `\x1b[0A${'x'.repeat(64 * 1024)}\rstep ${index} done\x1b[K\n`
      const next = appendNormalizedToTailBuffer(lines, '', chunk)
      lines = next.lines
    }
    const retained = collectHeap() - before

    expect(lines).toHaveLength(200)
    expect(lines.at(-1)).toBe('step 199 done')
    expect(retained).toBeLessThan(4 * 1024 * 1024)
  })

  it('owns the redraw partial line without re-owning carried rows', () => {
    const own = vi.spyOn(ownership, 'ownRetainedString')
    try {
      const seeded = appendNormalizedToTailBuffer([], '', 'row one\nrow two\nrow three\n')
      own.mockClear()
      // \x1b[2A drives the multiline redraw builder rather than the plain path.
      const redrawn = appendNormalizedToTailBuffer(
        seeded.lines,
        seeded.partialLine,
        '\x1b[2A\x1b[Krewritten two'
      )

      expect(redrawn.lines).toEqual(['row one'])
      expect(redrawn.partialLine).toBe('rewritten two')
      // Only the written run and the partial are owned; carried rows are never re-copied.
      expect(own.mock.calls).toEqual([['rewritten two'], ['rewritten two']])
    } finally {
      own.mockRestore()
    }
  })

  it('keeps completed lines and the tail transcript sharing the same owned rows', () => {
    const result = appendNormalizedToTailBuffer([], '', 'alpha line\nbeta line\n')
    expect(result.newlyCompletedLines).toEqual(['alpha line', 'beta line'])
    // The transcript keeps these exact strings, so owning them covers it transitively.
    result.newlyCompletedLines.forEach((line, index) => {
      expect(result.lines[index]).toBe(line)
    })
  })
})
