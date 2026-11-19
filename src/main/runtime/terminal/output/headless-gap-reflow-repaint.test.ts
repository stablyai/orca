import { assert, expect, it, vi } from 'vitest'
import { anchorStream, createRuntime, grid, headlessOf } from './headless-recovery-test-harness'

it('reads a ruled screen after recovery repaints an early reflow at the live PTY grid', async () => {
  const runtime = createRuntime()
  const ptyId = 'pty-reflow-gap'
  const liveGrid = { cols: 120, rows: 40 }
  let captureGrid = grid
  try {
    anchorStream(runtime, ptyId)
    runtime.onPtyData(ptyId, 'old geometry', 1)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => liveGrid,
      serializeProviderBuffer: async () => ({
        data: '\x1b[H\x1b[2Jready screen',
        ...captureGrid,
        seq: runtime.getPtyOutputSequence(ptyId),
        source: 'headless'
      })
    })
    runtime.reflowHeadlessTerminalToPtyGrid(ptyId, 120, 40)
    expect(headlessOf(runtime).readCaughtUpRuledScreen(ptyId)).toBeNull()
    runtime.notePtyDataGap(ptyId, 9)
    await vi.waitFor(async () =>
      assert(await headlessOf(runtime).serializeHeadlessTerminalBuffer(ptyId))
    )
    // Repainting at the wrong capture grid still reflows the image, so it cannot retire the guard.
    expect(headlessOf(runtime).readCaughtUpRuledScreen(ptyId)).toBeNull()
    captureGrid = liveGrid
    runtime.notePtyDataGap(ptyId, 9)
    await vi.waitFor(() =>
      expect(headlessOf(runtime).readCaughtUpRuledScreen(ptyId)).toEqual({
        lines: ['ready screen'],
        alternateScreen: false
      })
    )
  } finally {
    await runtime.onPtyExit(ptyId, 0)
  }
})
