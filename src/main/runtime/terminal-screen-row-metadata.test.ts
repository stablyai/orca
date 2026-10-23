import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { projectTerminalVisibleLines } from './orca-runtime-terminal-projection'
import { buildVisibleSnapshotReadFallback } from './terminal-tail-read'
import { MAX_TERMINAL_PREVIEW_CHARS } from './terminal-tail-limits'
import { redactWorkerTerminalView } from './orchestration/worker-terminal-redaction'
import type { RuntimeTerminalRead } from '../../shared/runtime-terminal-contracts'

const stream: RuntimeTerminalRead = {
  handle: 'terminal:test',
  status: 'running',
  tail: ['old stream'],
  tailRows: [{ wrapped: false, trailingSpaces: 0 }],
  truncated: false,
  oldestCursor: '0',
  nextCursor: '1',
  latestCursor: '1',
  returnedLineCount: 1
}

describe('screen row provenance boundaries', () => {
  it.each([5, 30, 100])(
    'retains actual wrap provenance through ANSI snapshot replay (%i)',
    async (cols) => {
      const original = new HeadlessEmulator({ cols, rows: 30 })
      const restored = new HeadlessEmulator({ cols, rows: 30 })
      try {
        await original.write('界e\u0301 dcap_abcdefghijklmnopqrstuvwx\r\nPermissionDenied\r\n')
        await restored.write(original.getSnapshot().snapshotAnsi)
        const projection = projectTerminalVisibleLines(restored)
        expect(projection).toEqual(projectTerminalVisibleLines(original))
        expect(restored.getVisibleRows().map((row) => row.text)).toEqual(restored.getVisibleLines())
        expect(restored.getBufferTailRows(30).map((row) => row.text)).toEqual(
          restored.getBufferTailLines(30)
        )
        const masked = redactWorkerTerminalView({
          tail: projection.lines,
          tailRows: projection.tailRows,
          source: 'screen'
        })
        expect(masked.tail.join('')).not.toContain('abcdefghijklmnopqrstuvwx')
        expect(masked.tail.join('')).toContain('PermissionDenied')
      } finally {
        original.dispose()
        restored.dispose()
      }
    }
  )

  it('does not join across a filtered blank soft row', async () => {
    const emulator = new HeadlessEmulator({ cols: 10, rows: 10 })
    try {
      await emulator.write(`dcap_sssss ${' '.repeat(9)}PermissionDenied\r\n`)
      const projection = projectTerminalVisibleLines(emulator)
      expect(projection.lines).toEqual(['dcap_sssss', 'Permission', 'Denied'])
      expect(projection.tailRows.map((row) => row.wrapped)).toEqual([false, false, true])
      expect(
        redactWorkerTerminalView({ tail: projection.lines, tailRows: projection.tailRows }).tail
      ).toEqual(projection.lines)
    } finally {
      emulator.dispose()
    }
  })

  it('preserves a Unicode whitespace boundary removed by display trimming', async () => {
    const emulator = new HeadlessEmulator({ cols: 10, rows: 10 })
    try {
      await emulator.write('dcap_ssss\u00a0PermissionDenied\r\n')
      const projection = projectTerminalVisibleLines(emulator)
      expect(projection.lines[0]).toBe('dcap_ssss')
      expect(projection.tailRows[0].trailingSpaces).toBe(1)
      expect(projection.tailRows[1].wrapped).toBe(true)
      expect(
        redactWorkerTerminalView({ tail: projection.lines, tailRows: projection.tailRows }).tail
      ).toEqual(projection.lines)
    } finally {
      emulator.dispose()
    }
  })

  it('aligns metadata after both line and character limits and ends continuity at the first row', () => {
    const lines = ['omitted', 'older', 'x'.repeat(MAX_TERMINAL_PREVIEW_CHARS), 'PermissionDenied']
    const rows = lines.map(() => ({ wrapped: true, trailingSpaces: 0 }))
    const read = buildVisibleSnapshotReadFallback(stream, lines, 3, undefined, rows)
    expect(read.tail.join('')).toHaveLength(MAX_TERMINAL_PREVIEW_CHARS)
    expect(read.tail).toHaveLength(2)
    expect(read.tailRows).toEqual([
      { wrapped: false, trailingSpaces: 0 },
      { wrapped: true, trailingSpaces: 0 }
    ])
    expect(read.limited).toBe(true)
  })

  it.each([undefined, []])(
    'drops stale stream provenance when the new projection has no aligned rows (%j)',
    (rows) => {
      const read = buildVisibleSnapshotReadFallback(
        stream,
        ['dcap_sssss', 'PermissionDenied'],
        2,
        undefined,
        rows
      )
      expect(read.tailRows).toBeUndefined()
      expect(redactWorkerTerminalView(read).tail).toEqual(read.tail)
      expect(redactWorkerTerminalView(read).warnings).toContain(
        'Terminal wrap information was unavailable; capability masking used complete lines.'
      )
    }
  )
})
