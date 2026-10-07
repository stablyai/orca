import { expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { makeDeferred } from './orca-runtime-test-fixtures.spec'
import { PTY_ID } from './headless-hydration-ownership-test-fixture'
import {
  captureRuntime,
  createCheckpointRuntime,
  kittyImage
} from './headless-model-checkpoint-test-fixture'

it('captures complete state before later bytes and refuses to publish an older sequence', async () => {
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, `FIRST${kittyImage()}`, 1)
  const state = runtime.model()
  const release = makeDeferred()
  const started = makeDeferred()
  vi.spyOn(state.ownership, 'settle').mockImplementationOnce(async () => {
    started.resolve()
    await release.promise
  })
  const pending = captureRuntime(runtime)
  await started.promise
  runtime.onPtyData(PTY_ID, 'LATER', 2)
  release.resolve()
  const capture = await pending
  try {
    expect(capture.outputSequence).toBe(`FIRST${kittyImage()}`.length)
    expect(capture.checkpoint.metadata.snapshot.snapshotAnsi).toContain('FIRST')
    expect(capture.checkpoint.metadata.snapshot.snapshotAnsi).not.toContain('LATER')
    expect(capture.checkpoint.metadata.graphics.resources.length).toBeGreaterThan(0)
    await expect(runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)).rejects.toThrow(
      /changed/
    )
    await state.writeChain
    expect(state.emulator.getVisibleLines().join('')).toContain('FIRST LATER')
  } finally {
    capture.dispose()
  }
})

it.each(['normal', 'alternate'])(
  'publishes complete %s state and preserves new output',
  async (mode) => {
    const runtime = createCheckpointRuntime()
    const input = `BEFORE${kittyImage()}${mode === 'alternate' ? `\x1b[?1049hALT${kittyImage(8)}` : ''}`
    runtime.onPtyData(PTY_ID, input, 1)
    const capture = await captureRuntime(runtime)
    const state = runtime.model()
    const original = state.emulator
    const originalText = original.getVisibleLines()
    const dispose = vi.spyOn(original, 'dispose')
    try {
      await runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)
      expect(runtime.model()).toBe(state)
      expect(state.emulator).not.toBe(original)
      expect(state.emulator.getVisibleLines()).toEqual(originalText)
      expect(state.emulator.isAlternateScreen).toBe(mode === 'alternate')
      expect(state.outputSequence).toBe(capture.outputSequence)
      expect(dispose).toHaveBeenCalledOnce()
      const copied = await captureRuntime(runtime)
      try {
        expect(copied.checkpoint.metadata.graphics).toEqual(capture.checkpoint.metadata.graphics)
        for (const resource of capture.checkpoint.metadata.graphics.resources) {
          expect(copied.checkpoint.copyResource(resource.id, resource.byteLength)).toEqual(
            capture.checkpoint.copyResource(resource.id, resource.byteLength)
          )
        }
      } finally {
        copied.dispose()
      }
      capture.dispose()
      runtime.onPtyData(PTY_ID, 'AFTER', 2)
      await state.writeChain
      expect(state.emulator.getVisibleLines().join('')).toContain('AFTER')
    } finally {
      capture.dispose()
    }
  }
)

it('retains actual resized geometry in a complete checkpoint', async () => {
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, kittyImage(), 1)
  runtime.reflowHeadlessTerminalToPtyGrid(PTY_ID, 30, 12)
  const capture = await captureRuntime(runtime)
  try {
    expect(capture.checkpoint.metadata.configuration).toMatchObject({ cols: 30, rows: 12 })
    await runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)
    expect(runtime.model().emulator.getAppliedSize()).toEqual({ cols: 30, rows: 12 })
  } finally {
    capture.dispose()
  }
})

it('rejects a checkpoint from another runtime owner', async () => {
  const source = createCheckpointRuntime()
  const target = createCheckpointRuntime()
  source.onPtyData(PTY_ID, `SOURCE${kittyImage()}`, 1)
  target.onPtyData(PTY_ID, 'TARGET', 1)
  const capture = await captureRuntime(source)
  const original = target.model().emulator
  try {
    await expect(target.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)).rejects.toThrow(
      /changed/
    )
    expect(target.model().emulator).toBe(original)
    await target.model().writeChain
    expect(original.getVisibleLines().join('')).toContain('TARGET')
  } finally {
    capture.dispose()
  }
})

it.each(['ordinary', 'conpty'])(
  'preserves %s reply policy across publication',
  async (platform) => {
    const runtime = createCheckpointRuntime(platform === 'conpty')
    runtime.onPtyData(PTY_ID, `BEFORE${kittyImage()}\x1b[c`, 1)
    const capture = await captureRuntime(runtime)
    try {
      await runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)
      expect(runtime.replies).not.toHaveBeenCalled()
      await runtime.model().emulator.write('\x1b[c', { forwardQueryReplies: true })
      expect(runtime.replies).toHaveBeenCalledWith(
        PTY_ID,
        platform === 'conpty' ? '\x1b[?61;4c' : '\x1b[?62;4;9;22c',
        'query-reply'
      )
    } finally {
      capture.dispose()
    }
  }
)

it('severs a retired emulator reply sink even while its record stays published', async () => {
  const runtime = createCheckpointRuntime()
  const state = runtime.model()
  const retired = state.emulator
  const replacement = new HeadlessEmulator({ cols: 20, rows: 10 })
  state.emulator = replacement
  try {
    await retired.write('\x1b[c', { forwardQueryReplies: true })
    expect(runtime.replies).not.toHaveBeenCalled()
  } finally {
    retired.dispose()
  }
})

it.each(['kitty', 'iip', 'sixel'])(
  'continues an active %s command after retiring the source and releasing its lease',
  async (protocol) => {
    const runtime = createCheckpointRuntime()
    const control = createCheckpointRuntime()
    const png = JSON.parse(
      readFileSync('src/shared/__fixtures__/terminal-raster-red.json', 'utf8')
    ).png
    const command =
      protocol === 'kitty'
        ? kittyImage()
        : protocol === 'iip'
          ? `\x1b]1337;File=inline=1;width=2px;height=2px:${png}\x07`
          : '\x1bPq"1;1;8;6#1;2;100;0;0#1!8~\x1b\\'
    const cut = command.length - 4
    const prefix = `FIRST${command.slice(0, cut)}`
    const suffix = `${command.slice(cut)}AFTER`
    runtime.onPtyData(PTY_ID, prefix, 1)
    control.onPtyData(PTY_ID, prefix, 1)
    const capture = await captureRuntime(runtime)
    try {
      await runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)
      capture.dispose()
      runtime.onPtyData(PTY_ID, suffix, 2)
      control.onPtyData(PTY_ID, suffix, 2)
      const actual = await captureRuntime(runtime)
      const expected = await captureRuntime(control)
      try {
        expect(actual.outputSequence).toBe(prefix.length + suffix.length)
        expect(runtime.model().emulator.getVisibleLines()).toEqual(
          control.model().emulator.getVisibleLines()
        )
        expect(actual.checkpoint.metadata.graphics).toEqual(expected.checkpoint.metadata.graphics)
        expect(actual.checkpoint.metadata.graphics.resources.length).toBeGreaterThan(0)
        for (const resource of expected.checkpoint.metadata.graphics.resources) {
          expect(actual.checkpoint.copyResource(resource.id, resource.byteLength)).toEqual(
            expected.checkpoint.copyResource(resource.id, resource.byteLength)
          )
        }
      } finally {
        actual.dispose()
        expected.dispose()
      }
    } finally {
      capture.dispose()
    }
  }
)

it.each([false, true])('rejects incomplete output even after later bytes: %s', async (later) => {
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, 'FIRST', 1)
  await runtime.model().writeChain
  const state = runtime.model()
  const write = state.emulator.write.bind(state.emulator)
  vi.spyOn(state.emulator, 'write').mockImplementationOnce(async (data, options) => {
    await write(data, options)
    throw new Error('Rejected parser receipt')
  })
  runtime.onPtyData(PTY_ID, 'PARTIAL', 2)
  await state.writeChain
  if (later) {
    runtime.onPtyData(PTY_ID, 'LATER', 3)
  }
  const capture = await runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, 1024 * 1024)
  try {
    expect(capture).toBeNull()
    expect(state.emulator.getVisibleLines().join('')).toContain('FIRSTPARTIAL')
    if (later) {
      expect(state.emulator.getVisibleLines().join('')).toContain('LATER')
    }
  } finally {
    capture?.dispose()
  }
})
