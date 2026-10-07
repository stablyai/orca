import { expect, it } from 'vitest'
import { createHydrationRuntime, PTY_ID } from './headless-hydration-ownership-test-fixture'
import {
  CHECKPOINT_THEME,
  createCheckpointRuntime,
  kittyImage,
  MODEL_BUDGET
} from './headless-model-checkpoint-test-fixture'
import { setTerminalViewAttributes } from './terminal-view-attribute-store'
import { OrcaRuntimeService } from './orca-runtime'
import { makeDeferred } from './orca-runtime-test-fixtures.spec'

const size = { cols: 20, rows: 10 }
const imageCellSize = { width: 3.25, height: 4.5 }

it('configures the production model before its first image output', async () => {
  const runtime = createHydrationRuntime()
  setTerminalViewAttributes(CHECKPOINT_THEME)
  runtime.preparePtyExecutionContext(PTY_ID, null, { resetIncarnation: true, size, imageCellSize })
  runtime.onPtyData(PTY_ID, kittyImage(), 1)
  const capture = await runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, MODEL_BUDGET)
  expect(capture).not.toBeNull()
  if (!capture) {
    throw new Error('Expected complete model')
  }
  try {
    expect(capture.checkpoint.metadata.configuration).toMatchObject({
      ...size,
      images: { cellSize: imageCellSize }
    })
    expect(capture.checkpoint.metadata.configuration.images?.colors.ansi).toHaveLength(256)
    expect(
      capture.checkpoint.metadata.graphics.components.find((part) => part.kind === 'decoded')
        ?.metadata
    ).toMatchObject({ images: [{ origCellSize: imageCellSize }] })
  } finally {
    capture.dispose()
  }
})

it('copies calibration before accepting asynchronous image bytes', async () => {
  const runtime = createHydrationRuntime()
  setTerminalViewAttributes(CHECKPOINT_THEME)
  const measured = { ...imageCellSize }
  runtime.preparePtyExecutionContext(PTY_ID, null, {
    resetIncarnation: true,
    size,
    imageCellSize: measured
  })
  measured.width = 999
  runtime.onPtyData(PTY_ID, kittyImage(), 1)
  const capture = await runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, MODEL_BUDGET)
  if (!capture) {
    throw new Error('Expected complete model')
  }
  try {
    expect(capture.checkpoint.metadata.configuration.images?.cellSize).toEqual(imageCellSize)
  } finally {
    capture.dispose()
  }
})

it('does not replace a live model on attachment', async () => {
  const runtime = createHydrationRuntime()
  setTerminalViewAttributes(CHECKPOINT_THEME)
  runtime.preparePtyExecutionContext(PTY_ID, null, { resetIncarnation: true, size, imageCellSize })
  const model = runtime.model()
  runtime.onPtyData(PTY_ID, kittyImage(), 1)
  expect(
    runtime.preparePtyExecutionContext(PTY_ID, 'other-distro', {
      preserveExisting: true,
      size: { cols: 80, rows: 24 },
      imageCellSize: { width: 20, height: 30 }
    })
  ).toBe(false)
  expect(runtime.model()).toBe(model)
  const capture = await runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, MODEL_BUDGET)
  if (!capture) {
    throw new Error('Expected complete model')
  }
  try {
    expect(capture.checkpoint.metadata.configuration.images?.cellSize).toEqual(imageCellSize)
  } finally {
    capture.dispose()
  }
})

it.each([
  { width: 0, height: 4 },
  { width: Number.NaN, height: 4 },
  { width: 3, height: Infinity }
])('declines invalid initial image calibration %j', (invalid) => {
  const runtime = createHydrationRuntime()
  setTerminalViewAttributes(CHECKPOINT_THEME)
  runtime.preparePtyExecutionContext(PTY_ID, null, {
    resetIncarnation: true,
    size,
    imageCellSize: invalid
  })
  expect(runtime.retainedState().model).toBe(false)
})

it('keeps image calibration unknown until the renderer publishes its full palette', () => {
  const runtime = createHydrationRuntime()
  runtime.preparePtyExecutionContext(PTY_ID, null, { resetIncarnation: true, size, imageCellSize })
  expect(runtime.retainedState().model).toBe(false)
})

it('does not invent a fresh image model when an existing daemon owner is still unknown', () => {
  const runtime = createHydrationRuntime()
  setTerminalViewAttributes(CHECKPOINT_THEME)
  runtime.preparePtyExecutionContext(PTY_ID, null, { size, imageCellSize })
  expect(runtime.retainedState().model).toBe(false)
})

it('clears a predecessor provider preference before the fresh model admits output', async () => {
  const runtime = createHydrationRuntime()
  runtime.preferProvider()
  setTerminalViewAttributes(CHECKPOINT_THEME)
  runtime.preparePtyExecutionContext(PTY_ID, null, { resetIncarnation: true, size, imageCellSize })
  expect(runtime.retainedState().providerPreferred).toBe(false)
  runtime.onPtyData(PTY_ID, kittyImage(), 1)
  const capture = await runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, MODEL_BUDGET)
  if (!capture) {
    throw new Error('Expected complete model')
  }
  capture.dispose()
})

it('retains the accepted calibration for future images after execution namespace correction', async () => {
  const runtime = createHydrationRuntime()
  setTerminalViewAttributes(CHECKPOINT_THEME)
  runtime.preparePtyExecutionContext(PTY_ID, null, { resetIncarnation: true, size, imageCellSize })
  runtime.onExternalPtyResize(PTY_ID, size.cols, size.rows, { width: 5.25, height: 6.5 })
  await runtime.model().writeChain
  runtime.preparePtyExecutionContext(PTY_ID, 'Ubuntu')
  runtime.onPtyData(PTY_ID, kittyImage(), 1)
  const capture = await runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, MODEL_BUDGET)
  if (!capture) {
    throw new Error('Expected complete model')
  }
  try {
    expect(capture.checkpoint.metadata.configuration.images?.cellSize).toEqual({
      width: 5.25,
      height: 6.5
    })
  } finally {
    capture.dispose()
  }
})

it('preserves a provisional image model before its PTY record is registered', async () => {
  const runtime = new OrcaRuntimeService()
  setTerminalViewAttributes(CHECKPOINT_THEME)
  try {
    runtime.preparePtyExecutionContext(PTY_ID, null, {
      resetIncarnation: true,
      size,
      imageCellSize
    })
    expect(
      runtime.preparePtyExecutionContext(PTY_ID, 'Ubuntu', {
        preserveExisting: true,
        resetIncarnation: true,
        size,
        imageCellSize: { width: 30, height: 40 }
      })
    ).toBe(false)
    runtime.onPtyData(PTY_ID, kittyImage(), 1)
    const capture = await runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, MODEL_BUDGET)
    if (!capture) {
      throw new Error('Expected complete model')
    }
    try {
      expect(capture.checkpoint.metadata.configuration.images?.cellSize).toEqual(imageCellSize)
    } finally {
      capture.dispose()
    }
  } finally {
    runtime.onPtyExit(PTY_ID, 0, undefined, { providerExitObserved: true })
  }
})

it('keeps an accepted cell size when namespace correction overtakes its queued model resize', async () => {
  const runtime = createHydrationRuntime()
  setTerminalViewAttributes(CHECKPOINT_THEME)
  runtime.preparePtyExecutionContext(PTY_ID, null, { resetIncarnation: true, size, imageCellSize })
  const predecessor = runtime.model()
  const release = makeDeferred()
  predecessor.writeChain = release.promise
  runtime.onExternalPtyResize(PTY_ID, size.cols, size.rows, { width: 5.25, height: 6.5 })
  runtime.preparePtyExecutionContext(PTY_ID, 'Ubuntu')
  release.resolve()
  await predecessor.writeChain
  runtime.onPtyData(PTY_ID, kittyImage(), 1)
  const capture = await runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, MODEL_BUDGET)
  if (!capture) {
    throw new Error('Expected complete model')
  }
  try {
    expect(capture.checkpoint.metadata.configuration.images?.cellSize).toEqual({
      width: 5.25,
      height: 6.5
    })
  } finally {
    capture.dispose()
  }
})

it.each(['generation', 'incarnation'] as const)(
  'does not carry queued image calibration across a changed %s',
  async (kind) => {
    const runtime = createCheckpointRuntime()
    const predecessor = runtime.model()
    const release = makeDeferred()
    predecessor.writeChain = release.promise
    runtime.onExternalPtyResize(PTY_ID, size.cols, size.rows, { width: 30, height: 40 })
    runtime.changeCaptureContext(kind)
    runtime.preparePtyExecutionContext(PTY_ID, 'Ubuntu')
    release.resolve()
    await predecessor.writeChain
    runtime.onPtyData(PTY_ID, kittyImage(), 1)
    const capture = await runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, MODEL_BUDGET)
    if (!capture) {
      throw new Error('Expected complete model')
    }
    try {
      expect(capture.checkpoint.metadata.configuration.images?.cellSize).toEqual({
        width: 2,
        height: 2
      })
    } finally {
      capture.dispose()
    }
  }
)
