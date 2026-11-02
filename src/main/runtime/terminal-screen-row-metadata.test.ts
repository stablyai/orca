import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { projectTerminalVisibleLines } from './orca-runtime-terminal-projection'
import { redactWorkerTerminalView } from './orchestration/worker-terminal-redaction'

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
})
