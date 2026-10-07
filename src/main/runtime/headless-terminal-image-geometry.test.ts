import { expect, it, vi } from 'vitest'
import { makeDeferred } from './orca-runtime-test-fixtures.spec'
import { PTY_ID } from './headless-hydration-ownership-test-fixture'
import {
  captureRuntime,
  createCheckpointRuntime,
  kittyImage
} from './headless-model-checkpoint-test-fixture'

const measured = { width: 3.25, height: 4.5 }

it('orders same-grid cell measurements between actual output chunks', async () => {
  const runtime = createCheckpointRuntime()
  const state = runtime.model()
  runtime.onPtyData(PTY_ID, kittyImage(7), 1)
  runtime.onExternalPtyResize(PTY_ID, 20, 10, measured)
  runtime.onPtyData(PTY_ID, kittyImage(8), 2)
  const capture = await captureRuntime(runtime)
  try {
    expect(state.outputSequence).toBe(kittyImage(7).length + kittyImage(8).length)
    expect(capture.checkpoint.metadata.configuration.images?.cellSize).toEqual(measured)
    const decoded = capture.checkpoint.metadata.graphics.components.find(
      (part) => part.kind === 'decoded'
    )
    expect(decoded?.metadata).toMatchObject({
      images: [{ origCellSize: { width: 2, height: 2 } }, { origCellSize: measured }]
    })
  } finally {
    capture.dispose()
  }
})

it('invalidates publication after a font change with an unchanged byte sequence and grid', async () => {
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, kittyImage(), 1)
  const capture = await captureRuntime(runtime)
  try {
    runtime.onExternalPtyResize(PTY_ID, 20, 10, measured)
    await runtime.model().writeChain
    await expect(runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)).rejects.toThrow(
      /changed/
    )
    const current = await captureRuntime(runtime)
    try {
      expect(current.checkpoint.metadata.configuration.images?.cellSize).toEqual(measured)
    } finally {
      current.dispose()
    }
  } finally {
    capture.dispose()
  }
})

it('does not apply queued measurements to a replaced model', async () => {
  const runtime = createCheckpointRuntime()
  const retired = runtime.model()
  const release = makeDeferred()
  retired.writeChain = release.promise
  const resize = vi.spyOn(retired.emulator, 'resize')
  runtime.onExternalPtyResize(PTY_ID, 20, 10, measured)
  runtime.notePtyDataGap(PTY_ID)
  runtime.onPtyData(PTY_ID, 'SUCCESSOR', 1)
  release.resolve()
  await retired.writeChain
  await runtime.model().writeChain
  expect(resize).not.toHaveBeenCalled()
  expect(runtime.model().emulator.getVisibleLines().join('')).toContain('SUCCESSOR')
})

it('ignores a passive desktop report while retaining the active cell measurements', async () => {
  const runtime = createCheckpointRuntime()
  runtime.recordRendererGeometry(PTY_ID, 100, 40)
  const capture = await captureRuntime(runtime)
  try {
    expect(capture.checkpoint.metadata.configuration.images?.cellSize).toEqual({
      width: 2,
      height: 2
    })
    expect(capture.checkpoint.metadata.configuration.cols).toBe(20)
  } finally {
    capture.dispose()
  }
})

it.each(['generation', 'incarnation'] as const)(
  'fences a queued calibration across %s changes',
  async (kind) => {
    const runtime = createCheckpointRuntime()
    const state = runtime.model()
    const release = makeDeferred()
    state.writeChain = release.promise
    const resize = vi.spyOn(state.emulator, 'resize')
    runtime.onExternalPtyResize(PTY_ID, 20, 10, measured)
    runtime.changeCaptureContext(kind)
    release.resolve()
    await state.writeChain
    expect(resize).not.toHaveBeenCalled()
  }
)

it('copies incoming measurements before waiting for earlier output', async () => {
  const runtime = createCheckpointRuntime()
  const state = runtime.model()
  const release = makeDeferred()
  state.writeChain = release.promise
  const supplied = { ...measured }
  runtime.onExternalPtyResize(PTY_ID, 20, 10, supplied)
  supplied.width = 999
  release.resolve()
  const capture = await captureRuntime(runtime)
  try {
    expect(capture.checkpoint.metadata.configuration.images?.cellSize).toEqual(measured)
  } finally {
    capture.dispose()
  }
})
