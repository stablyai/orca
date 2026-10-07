import { expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { makeDeferred } from './orca-runtime-test-fixtures.spec'
import { PTY_ID, createHydrationRuntime } from './headless-hydration-ownership-test-fixture'
import {
  CHECKPOINT_THEME,
  captureRuntime,
  createCheckpointRuntime,
  kittyImage
} from './headless-model-checkpoint-test-fixture'
import { setTerminalViewAttributes } from './terminal-view-attribute-store'

async function waitingPublication() {
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, `FIRST${kittyImage()}`, 1)
  const capture = await captureRuntime(runtime)
  const state = runtime.model()
  const original = state.emulator
  const originalDispose = vi.spyOn(original, 'dispose')
  const release = makeDeferred()
  const started = makeDeferred()
  const write = HeadlessEmulator.prototype.write
  vi.spyOn(HeadlessEmulator.prototype, 'write').mockImplementationOnce(async function (
    this: HeadlessEmulator,
    data,
    options
  ) {
    started.resolve()
    await release.promise
    await write.call(this, data, options)
  })
  const pending = runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)
  await started.promise
  const staged = runtime.constructed.at(-1)
  if (!staged || staged === original) {
    throw new Error('Expected staging model')
  }
  const stagedDispose = vi.spyOn(staged, 'dispose')
  return {
    runtime,
    capture,
    state,
    original,
    originalDispose,
    staged,
    stagedDispose,
    release,
    pending
  }
}

it.each(['output', 'resize', 'clear', 'reset', 'theme', 'generation', 'incarnation'])(
  'keeps the original model if %s arrives during preparation',
  async (operation) => {
    const p = await waitingPublication()
    let mutation: Promise<void> | undefined
    try {
      if (operation === 'output') {
        p.runtime.onPtyData(PTY_ID, 'LATER', 2)
      } else if (operation === 'resize') {
        p.runtime.reflowHeadlessTerminalToPtyGrid(PTY_ID, 30, 12)
      } else if (operation === 'clear') {
        mutation = p.runtime.clearHeadlessTerminalBuffer(PTY_ID)
      } else if (operation === 'theme') {
        setTerminalViewAttributes(CHECKPOINT_THEME)
      } else if (operation === 'generation' || operation === 'incarnation') {
        p.runtime.changeCaptureContext(operation)
      } else {
        mutation = p.runtime.resetHeadlessTerminalInputModes(PTY_ID)
      }
      p.release.resolve()
      await expect(p.pending).rejects.toThrow(/changed/)
      await p.state.writeChain
      await mutation
      expect(p.state.emulator).toBe(p.original)
      expect(p.originalDispose).not.toHaveBeenCalled()
      expect(p.stagedDispose).toHaveBeenCalledOnce()
      if (operation === 'output') {
        expect(p.original.getVisibleLines().join('')).toContain('LATER')
      } else if (operation === 'resize') {
        expect(p.original.getAppliedSize()).toEqual({ cols: 30, rows: 12 })
      }
    } finally {
      p.release.resolve()
      await p.pending.catch(() => {})
      await p.state.writeChain
      await mutation
      p.capture.dispose()
    }
  }
)

it('does not publish into an owner replaced during preparation', async () => {
  const p = await waitingPublication()
  try {
    p.runtime.notePtyDataGap(PTY_ID)
    p.runtime.onPtyData(PTY_ID, 'REPLACEMENT', 2)
    const replacement = p.runtime.model()
    p.release.resolve()
    await expect(p.pending).rejects.toThrow(/changed/)
    await p.state.writeChain
    await replacement.writeChain
    expect(p.runtime.model()).toBe(replacement)
    expect(replacement.emulator.getVisibleLines().join('')).toContain('REPLACEMENT')
    expect(p.originalDispose).toHaveBeenCalledOnce()
    expect(p.stagedDispose).toHaveBeenCalledOnce()
  } finally {
    p.release.resolve()
    await p.pending.catch(() => {})
    p.capture.dispose()
  }
})

it('rejects an expired lease during preparation without disposing the original', async () => {
  const p = await waitingPublication()
  try {
    p.capture.dispose()
    p.release.resolve()
    await expect(p.pending).rejects.toThrow(/disposed/)
    expect(p.state.emulator).toBe(p.original)
    expect(p.originalDispose).not.toHaveBeenCalled()
    expect(p.stagedDispose).toHaveBeenCalledOnce()
    p.runtime.onPtyData(PTY_ID, 'LATER', 2)
    await p.state.writeChain
    expect(p.original.getVisibleLines().join('')).toContain('LATER')
  } finally {
    p.release.resolve()
    await p.pending.catch(() => {})
    p.capture.dispose()
  }
})

it('rejects a resize queued after capture even if it returns to the same geometry', async () => {
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, `FIRST${kittyImage()}`, 1)
  const capture = await captureRuntime(runtime)
  const original = runtime.model().emulator
  try {
    runtime.reflowHeadlessTerminalToPtyGrid(PTY_ID, 10, 5)
    runtime.reflowHeadlessTerminalToPtyGrid(PTY_ID, 20, 10)
    await runtime.model().writeChain
    await expect(runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)).rejects.toThrow(
      /changed/
    )
    expect(runtime.model().emulator).toBe(original)
  } finally {
    capture.dispose()
  }
})

it('leaves output runnable when capture admission rejects', async () => {
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, kittyImage(), 1)
  await expect(runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, 1)).rejects.toThrow(/budget/)
  runtime.onPtyData(PTY_ID, 'LATER', 2)
  await runtime.model().writeChain
  expect(runtime.model().emulator.getVisibleLines().join('')).toContain('LATER')
})

it('preserves the original if restoring graphics fails', async () => {
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, `FIRST${kittyImage()}`, 1)
  const capture = await captureRuntime(runtime)
  const original = runtime.model().emulator
  vi.spyOn(capture.checkpoint, 'restoreImages').mockRejectedValueOnce(new Error('Raster failure'))
  try {
    await expect(runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)).rejects.toThrow(
      'Raster failure'
    )
    expect(runtime.model().emulator).toBe(original)
    const staged = runtime.constructed.at(-1)
    expect(staged).not.toBe(original)
    expect(() => staged?.captureModelCheckpoint(1024 * 1024)).toThrow(/disposed/)
    runtime.onPtyData(PTY_ID, 'LATER', 2)
    await runtime.model().writeChain
    expect(original.getVisibleLines().join('')).toContain('LATER')
  } finally {
    capture.dispose()
  }
})

it('allows one publication when the same capture is submitted concurrently', async () => {
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, kittyImage(), 1)
  const capture = await captureRuntime(runtime)
  const original = runtime.model().emulator
  const dispose = vi.spyOn(original, 'dispose')
  try {
    const first = runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)
    const second = runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)
    await expect(second).rejects.toThrow(/changed/)
    await first
    expect(runtime.model().emulator).not.toBe(original)
    expect(dispose).toHaveBeenCalledOnce()
  } finally {
    capture.dispose()
  }
})

it('releases runtime owner access when a capture is disposed', async () => {
  const runtime = createCheckpointRuntime()
  const capture = await captureRuntime(runtime)
  const source = runtime.model()
  capture.dispose()
  expect(() => capture.source).toThrow(/disposed/)
  expect(() => capture.queueBoundary).toThrow(/disposed/)
  expect(runtime.model()).toBe(source)
})

it('preserves later output after a failed clear but rejects full-model capture', async () => {
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, 'FIRST', 1)
  const state = runtime.model()
  vi.spyOn(state.emulator, 'clearScrollback').mockImplementationOnce(() => {
    throw new Error('Clear failed')
  })
  await expect(runtime.clearHeadlessTerminalBuffer(PTY_ID)).rejects.toThrow('Clear failed')
  runtime.onPtyData(PTY_ID, 'LATER', 2)
  await state.writeChain
  expect(state.emulator.getVisibleLines().join('')).toContain('FIRSTLATER')
  await expect(
    runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, 1024 * 1024)
  ).resolves.toBeNull()
})

it.each(['resize', 'reset'])('rejects complete capture after failed %s', async (operation) => {
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, 'FIRST', 1)
  const state = runtime.model()
  await state.writeChain
  if (operation === 'resize') {
    vi.spyOn(state.emulator, 'resize').mockImplementationOnce(() => {
      throw new Error('Resize failed')
    })
    runtime.reflowHeadlessTerminalToPtyGrid(PTY_ID, 30, 12)
  } else {
    vi.spyOn(state.emulator, 'write').mockRejectedValueOnce(new Error('Reset failed'))
    await expect(runtime.resetHeadlessTerminalInputModes(PTY_ID)).rejects.toThrow('Reset failed')
  }
  runtime.onPtyData(PTY_ID, 'LATER', 2)
  await state.writeChain
  expect(state.emulator.getVisibleLines().join('')).toContain('FIRSTLATER')
  await expect(
    runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, 1024 * 1024)
  ).resolves.toBeNull()
})

it.each(['seed', 'hydration'])('rejects complete capture after failed %s input', async (kind) => {
  const runtime = createHydrationRuntime()
  const write = HeadlessEmulator.prototype.write
  vi.spyOn(HeadlessEmulator.prototype, 'write').mockImplementationOnce(async function (
    this: HeadlessEmulator,
    data,
    options
  ) {
    await write.call(this, data, options)
    throw new Error('Rejected seed receipt')
  })
  if (kind === 'seed') {
    runtime.seedHeadlessTerminal(PTY_ID, 'HISTORY', { cols: 20, rows: 10 })
  } else {
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => ({ cols: 20, rows: 10 }),
      hasRendererSerializer: () => true,
      serializeBuffer: async () => ({ data: 'HISTORY', cols: 20, rows: 10 })
    })
  }
  runtime.onPtyData(PTY_ID, 'LIVE', 1)
  const state = runtime.model()
  await state.writeChain
  expect(state.emulator.getVisibleLines().join('')).toContain('HISTORYLIVE')
  await expect(
    runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, 1024 * 1024)
  ).resolves.toBeNull()
})
