import { afterEach, expect, it, vi } from 'vitest'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import { anchorStream, createRuntime, grid, headlessOf } from './headless-recovery-test-harness'

afterEach(() => {
  vi.restoreAllMocks()
})

// A recovered model owns screen mode; no provider mirror may keep parsing its later output.
it.each([10, 100])(
  'recovers %i gapped terminals without a leftover mode scan per chunk',
  async (count) => {
    const runtime = createRuntime()
    const ptyIds = Array.from({ length: count }, (_, index) => `pty-recovered-${index}`)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      serializeProviderBuffer: async (ptyId): Promise<PtyProviderBufferSnapshot> => ({
        data: '\x1b[H\x1b[2Jrecovered',
        ...grid,
        seq: runtime.getPtyOutputSequence(ptyId),
        source: 'headless',
        alternateScreen: false
      })
    })
    try {
      for (const ptyId of ptyIds) {
        anchorStream(runtime, ptyId)
        runtime.onPtyData(ptyId, 'before\r\n', 1)
        runtime.notePtyDataGap(ptyId, 9)
      }
      await vi.waitFor(
        () => {
          for (const ptyId of ptyIds) {
            expect(headlessOf(runtime).readWholeScreenModel(ptyId)).not.toBeNull()
          }
        },
        { timeout: 20_000 }
      )
      const scan = vi.spyOn(TerminalKittyKeyboardModeTracker.prototype, 'scan')
      for (let chunk = 0; chunk < 5; chunk += 1) {
        for (const ptyId of ptyIds) {
          runtime.onPtyData(ptyId, `line ${chunk}\r\n`, 2)
        }
      }
      expect(scan).toHaveBeenCalledTimes(0)
    } finally {
      await Promise.all(ptyIds.map((ptyId) => runtime.onPtyExit(ptyId, 0)))
    }
  },
  30_000
)
