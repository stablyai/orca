import { expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../../../daemon/headless-emulator'
import {
  MODEL_BUDGET,
  captureRuntime,
  kittyImage
} from '../../../runtime/headless-model-checkpoint-test-fixture'
import { PTY_ID } from '../../../runtime/headless-hydration-ownership-test-fixture'
import { readTerminalModelCheckpoint } from '../../../../shared/terminal-model-checkpoint-reader'
import raster from '../../../../shared/__fixtures__/terminal-raster-red.json'
import { contents, incarnationId, install } from './model-checkpoint-test-fixture'
import { transport } from './model-checkpoint-reader-test-fixture'

it('copies a complete model through real IPC and releases the host capture before returning', async () => {
  const runtime = install()
  const captured = vi.spyOn(runtime, 'captureHeadlessTerminalModelCheckpoint')
  const release = vi.spyOn(transport, 'releaseModelCheckpoint')
  const received = await readTerminalModelCheckpoint(transport, PTY_ID, incarnationId, () => true)
  if (!received) {
    throw new Error('Expected complete model')
  }
  try {
    expect(release).toHaveBeenCalledOnce()
    const hostCapture = await captured.mock.results[0]?.value
    expect(hostCapture?.checkpoint.isDisposed).toBe(true)
    expect(received.checkpoint.isDisposed).toBe(false)
    expect(received.sourceSeq).toBe(`FIRST${kittyImage()}`.length)
    expect(received.checkpoint.metadata.snapshot.snapshotAnsi).toContain('FIRST')
    const restored = await HeadlessEmulator.prepareModelCheckpoint(received.checkpoint)
    try {
      expect(restored.getVisibleLines()).toEqual(runtime.model().emulator.getVisibleLines())
      const copy = restored.captureModelCheckpoint(MODEL_BUDGET)
      try {
        expect(copy.metadata.graphics).toEqual(received.checkpoint.metadata.graphics)
        for (const resource of copy.metadata.graphics.resources) {
          expect(copy.copyResource(resource.id, resource.byteLength)).toEqual(
            received.checkpoint.copyResource(resource.id, resource.byteLength)
          )
        }
      } finally {
        copy.dispose()
      }
    } finally {
      restored.dispose()
    }
  } finally {
    received.checkpoint.dispose()
  }
})

it.each(['kitty', 'iip', 'sixel'])(
  'continues an active %s parser after IPC transfer and complete source retirement',
  async (protocol) => {
    const runtime = install()
    const command =
      protocol === 'kitty'
        ? kittyImage(9)
        : protocol === 'iip'
          ? `\x1b]1337;File=inline=1;width=2px;height=2px:${raster.png}\x07`
          : '\x1bPq"1;1;8;6#1;2;100;0;0#1!8~\x1b\\'
    const cut = command.length - 4
    runtime.onPtyData(PTY_ID, command.slice(0, cut), 2)
    const received = await readTerminalModelCheckpoint(transport, PTY_ID, incarnationId, () => true)
    if (!received) {
      throw new Error('Expected active parser model')
    }
    const suffix = `${command.slice(cut)}AFTER`
    runtime.onPtyData(PTY_ID, suffix, 3)
    const uninterrupted = await captureRuntime(runtime)
    const expectedLines = runtime.model().emulator.getVisibleLines()
    runtime.onPtyExit(PTY_ID, 0, incarnationId, { providerExitObserved: true })
    const restored = await HeadlessEmulator.prepareModelCheckpoint(received.checkpoint)
    received.checkpoint.dispose()
    try {
      await restored.write(suffix)
      expect(restored.getVisibleLines()).toEqual(expectedLines)
      const actual = restored.captureModelCheckpoint(MODEL_BUDGET)
      const expected = uninterrupted.checkpoint
      try {
        expect(actual.metadata.graphics).toEqual(expected.metadata.graphics)
        for (const resource of expected.metadata.graphics.resources) {
          expect(actual.copyResource(resource.id, resource.byteLength)).toEqual(
            expected.copyResource(resource.id, resource.byteLength)
          )
        }
      } finally {
        actual.dispose()
        expected.dispose()
      }
    } finally {
      restored.dispose()
      uninterrupted.dispose()
    }
  }
)

it('reads large binary resources in bounded windows while newer bytes keep flowing', async () => {
  const runtime = install()
  const data = `\x1b_Ga=T,f=32,s=300,v=300,i=11,q=2;${Buffer.alloc(300 * 300 * 4, 255).toString('base64')}\x1b\\`
  runtime.onPtyData(PTY_ID, data, 2)
  const originalRead = transport.readModelCheckpoint
  let newer = false
  const read = vi.spyOn(transport, 'readModelCheckpoint').mockImplementation(async (id, window) => {
    const bytes = await originalRead(id, window)
    if (!newer) {
      newer = true
      runtime.onPtyData(PTY_ID, 'LATER', 3)
    }
    return bytes
  })
  const received = await readTerminalModelCheckpoint(transport, PTY_ID, incarnationId, () => true)
  if (!received) {
    throw new Error('Expected large complete model')
  }
  try {
    expect(received.sourceSeq).toBe(`FIRST${kittyImage()}`.length + data.length)
    expect(received.checkpoint.metadata.snapshot.snapshotAnsi).not.toContain('LATER')
    expect(
      read.mock.calls.some(([, window]) => window.resourceId !== null && window.offset > 0)
    ).toBe(true)
    expect(
      read.mock.calls.every(([, window]) => window.length > 0 && window.length <= 262144)
    ).toBe(true)
  } finally {
    received.checkpoint.dispose()
  }
})

it.each(['metadata', 'binary', 'release'])(
  'rejects a request that becomes stale during %s delivery',
  async (phase) => {
    install()
    let current = true
    const release = vi.spyOn(transport, 'releaseModelCheckpoint')
    if (phase === 'release') {
      const original = release.getMockImplementation()
      release.mockImplementation(async (id, leaseId) => {
        current = false
        return original ? original(id, leaseId) : false
      })
    } else {
      const original = transport.readModelCheckpoint
      vi.spyOn(transport, 'readModelCheckpoint').mockImplementation(async (id, window) => {
        const bytes = await original(id, window)
        if ((window.resourceId === null) === (phase === 'metadata')) {
          current = false
        }
        return bytes
      })
    }
    await expect(
      readTerminalModelCheckpoint(transport, PTY_ID, incarnationId, () => current)
    ).rejects.toThrow('stale')
    expect(release).toHaveBeenCalledOnce()
  }
)

it('rejects a host lease retired during binary delivery and releases already copied resources', async () => {
  install()
  const original = transport.readModelCheckpoint
  const release = vi.spyOn(transport, 'releaseModelCheckpoint')
  vi.spyOn(transport, 'readModelCheckpoint').mockImplementation(async (id, window) => {
    if (window.resourceId !== null) {
      contents.emit('render-process-gone')
    }
    return original(id, window)
  })
  await expect(
    readTerminalModelCheckpoint(transport, PTY_ID, incarnationId, () => true)
  ).rejects.toThrow('Invalid or expired')
  expect(release).toHaveBeenCalledOnce()
})

it('returns owned resources even when the host cannot acknowledge release', async () => {
  install()
  vi.spyOn(transport, 'releaseModelCheckpoint').mockRejectedValueOnce(new Error('connection lost'))
  const received = await readTerminalModelCheckpoint(transport, PTY_ID, incarnationId, () => true)
  if (!received) {
    throw new Error('Expected owned complete model')
  }
  expect(received.checkpoint.isDisposed).toBe(false)
  received.checkpoint.dispose()
})
