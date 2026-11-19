import { assert, expect, it, vi } from 'vitest'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import {
  anchorStream,
  createRuntime,
  grid,
  headlessOf,
  replay
} from './headless-recovery-test-harness'

it('recovers a stamped gap received before the initial spawn reply without another output byte', async () => {
  const runtime = createRuntime()
  const ptyId = 'pty-early-gap'
  let release: ((snapshot: PtyProviderBufferSnapshot) => void) | undefined
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: () =>
      new Promise<PtyProviderBufferSnapshot>((resolve) => {
        release = resolve
      })
  })
  try {
    runtime.anchorProviderSequence(ptyId, runtime.onPtyData(ptyId, 'pre', 1, 3), 3)
    runtime.notePtyDataGap(ptyId, 9)
    runtime.anchorProviderSequence(ptyId, runtime.onPtyData(ptyId, 'after', 2, 5), 17)
    expect(headlessOf(runtime).readWholeScreenModel(ptyId)).toBeNull()
    runtime.synchronizePtyOutputSequenceFromProvider(ptyId, { value: 0, generation: 'reset' }, 0)
    expect(headlessOf(runtime).readWholeScreenModel(ptyId)).toBeNull()
    await vi.waitFor(() => assert(release))
    expect(await headlessOf(runtime).serializeHeadlessTerminalBuffer(ptyId)).toBeNull()
    assert(release)
    release({ data: '\x1b[H\x1b[2Jprovider ready', ...grid, seq: 17, source: 'headless' })
    await vi.waitFor(async () => {
      const snapshot = await headlessOf(runtime).serializeHeadlessTerminalBuffer(ptyId)
      expect(await replay(snapshot, '')).toEqual(['provider ready'])
    })
    expect(headlessOf(runtime).readWholeScreenModel(ptyId)).not.toBeNull()
  } finally {
    await runtime.onPtyExit(ptyId, 0)
  }
})

it('recovers an early stamped gap once a continued attach syncs after earlier bytes', async () => {
  const runtime = createRuntime()
  const ptyId = 'pty-early-gap-continued'
  const releases: ((snapshot: PtyProviderBufferSnapshot) => void)[] = []
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: () =>
      new Promise<PtyProviderBufferSnapshot>((resolve) => {
        releases.push(resolve)
      })
  })
  try {
    runtime.anchorProviderSequence(ptyId, runtime.onPtyData(ptyId, 'pre', 1, 3), 3)
    runtime.notePtyDataGap(ptyId, 9)
    runtime.anchorProviderSequence(ptyId, runtime.onPtyData(ptyId, 'after', 2, 5), 17)
    runtime.synchronizePtyOutputSequenceFromProvider(
      ptyId,
      { value: 3, generation: 'continued' },
      3
    )
    runtime.anchorProviderSequence(ptyId, runtime.onPtyData(ptyId, '!', 3, 1), 18)
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    releases[0]?.({ data: '\x1b[H\x1b[2Jprovider ready', ...grid, seq: 18, source: 'headless' })
    await vi.waitFor(async () => {
      const snapshot = await headlessOf(runtime).serializeHeadlessTerminalBuffer(ptyId)
      expect(await replay(snapshot, '')).toEqual(['provider ready'])
    })
    runtime.anchorProviderSequence(ptyId, runtime.onPtyData(ptyId, '?', 4, 1), 19)
    expect(releases).toHaveLength(1)
  } finally {
    await runtime.onPtyExit(ptyId, 0)
  }
})

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
