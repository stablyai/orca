import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import {
  clearNativeWindowsConptyPty,
  markNativeWindowsConptyPty
} from './terminal-model-query-authority'
import {
  anchorStream,
  createRuntime,
  historyGrid,
  historyReads
} from './headless-recovery-test-harness'

// Recovering ConPTY reads answer with rendered cells or nothing: never a half-drawn frame or the gapped stream tail.
function heldRecoveryConpty(
  ptyId: string,
  readerSnapshot: (runtime: OrcaRuntimeService) => PtyProviderBufferSnapshot | null
) {
  const runtime = createRuntime(100)
  const reads = historyReads(runtime, ptyId)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => historyGrid,
    serializeProviderBuffer: async (_ptyId, opts) =>
      opts?.recovery
        ? new Promise<null>((resolve) =>
            opts.signal?.addEventListener('abort', () => resolve(null), { once: true })
          )
        : readerSnapshot(runtime)
  })
  markNativeWindowsConptyPty(ptyId)
  const close = async () => {
    clearNativeWindowsConptyPty(ptyId)
    await runtime.onPtyExit(ptyId, 0)
  }
  return { runtime, ...reads, close }
}

it('never returns a half-drawn provider frame as recovering ConPTY history', async () => {
  const ptyId = 'pty-half-drawn'
  const { runtime, read, close } = heldRecoveryConpty(ptyId, (live) => ({
    data: 'HALF-DRAWN',
    ...historyGrid,
    seq: live.getPtyOutputSequence(ptyId),
    source: 'headless',
    synchronizedOutput: true
  }))
  try {
    anchorStream(runtime, ptyId)
    runtime.onPtyData(ptyId, 'stale-1\r\nstale-2\r\n', 1)
    runtime.notePtyDataGap(ptyId, 9)
    const result = await read()
    expect(result.tail).toEqual([])
    expect(result.limited).toBe(true)
    expect(result.source).toBe('screen-unavailable')
  } finally {
    await close()
  }
})

it('returns empty limited ConPTY alternate-screen reads instead of the gapped stream during recovery', async () => {
  const runtime = createRuntime(100)
  const ptyId = 'pty-alternate-unavailable'
  const { read, stream } = historyReads(runtime, ptyId)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => historyGrid,
    // Recovery's frames predate its journal: they keep the alternate mode known but never rebuild. Readers get none.
    serializeProviderBuffer: async (_ptyId, opts) =>
      opts?.recovery
        ? { data: '', ...historyGrid, seq: 0, source: 'headless', alternateScreen: true }
        : null
  })
  markNativeWindowsConptyPty(ptyId)
  try {
    anchorStream(runtime, ptyId)
    runtime.onPtyData(ptyId, '\x1b[?1049hstale-1\r\nstale-2\r\n', 1)
    runtime.notePtyDataGap(ptyId, 9)
    await vi.waitFor(() => expect(runtime.isTerminalAlternateScreen(ptyId)).toBe(true))
    expect(stream().tail).toEqual(['stale-1', 'stale-2'])
    const result = await read()
    expect(result.tail).toEqual([])
    expect(result.limited).toBe(true)
    expect(result.source).toBe('screen-unavailable')
  } finally {
    clearNativeWindowsConptyPty(ptyId)
    await runtime.onPtyExit(ptyId, 0)
  }
})
