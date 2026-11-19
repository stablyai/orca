import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'

// Perf contract (#43889): delayed provider replies must not retain a scanner for every obsolete reader epoch.
it.each([10, 100])('bounds live capture scanners across %i held gap/read pairs', async (pairs) => {
  vi.useFakeTimers()
  const runtime = new OrcaRuntimeService()
  const ptyId = 'pty-held-readers'
  const grid = { cols: 80, rows: 24 }
  const recoveryStarted = Promise.withResolvers<void>()
  const recoveryReply = Promise.withResolvers<PtyProviderBufferSnapshot | null>()
  const readerReplies: ((snapshot: PtyProviderBufferSnapshot) => void)[] = []
  const reads: ReturnType<OrcaRuntimeService['serializeTerminalBuffer']>[] = []
  let released = false
  const snapshot = (data: string): PtyProviderBufferSnapshot => ({
    data,
    ...grid,
    seq: runtime.getPtyOutputSequence(ptyId),
    source: 'headless'
  })
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async (_ptyId, opts) => {
      if (opts?.recovery) {
        recoveryStarted.resolve()
        return recoveryReply.promise
      }
      if (released) {
        return snapshot('fresh screen')
      }
      return new Promise<PtyProviderBufferSnapshot>((resolve) => readerReplies.push(resolve))
    }
  })
  const scans = vi.spyOn(TerminalKittyKeyboardModeTracker.prototype, 'scan')
  const ingestAndCountScanners = () => {
    scans.mockClear()
    runtime.onPtyData(ptyId, '\x1b[?1049l', 1)
    return scans.mock.calls.length
  }
  try {
    runtime.synchronizePtyOutputSequenceFromProvider(ptyId, { value: 0, generation: 'continued' })
    runtime.anchorProviderSequence(ptyId, 0, 0)
    runtime.notePtyDataGap(ptyId, 1)
    await recoveryStarted.promise
    for (let pair = 0; pair < pairs; pair++) {
      runtime.notePtyDataGap(ptyId, 1)
      // The recovery scanner survives; the previous reader's scanner retires before another read.
      expect(ingestAndCountScanners()).toBe(1)
      reads.push(runtime.serializeTerminalBuffer(ptyId, { scrollbackRows: 1000 }))
      expect(ingestAndCountScanners()).toBe(2)
    }
    runtime.notePtyDataGap(ptyId, 1)
    expect(ingestAndCountScanners()).toBe(1)
    released = true
    for (const reply of readerReplies) {
      reply(snapshot('STALE IMAGE'))
    }
    for (const image of await Promise.all(reads)) {
      expect(image).toBeNull()
    }
    expect((await runtime.serializeTerminalBuffer(ptyId, { scrollbackRows: 1000 }))?.data).toBe(
      'fresh screen'
    )
  } finally {
    released = true
    for (const reply of readerReplies) {
      reply(snapshot('STALE IMAGE'))
    }
    await runtime.onPtyExit(ptyId, 0)
    recoveryReply.resolve(null)
    await Promise.all(reads)
    scans.mockRestore()
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})
