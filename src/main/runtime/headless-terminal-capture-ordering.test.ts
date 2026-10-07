import { expect, it, vi } from 'vitest'
import { makeDeferred } from './orca-runtime-test-fixtures.spec'
import { createHydrationRuntime, PTY_ID } from './headless-hydration-ownership-test-fixture'

async function waitingCapture() {
  const runtime = createHydrationRuntime()
  runtime.onPtyData(PTY_ID, 'FIRST\r\n', 1)
  await runtime.model().writeChain
  const state = runtime.model()
  const started = makeDeferred()
  const release = makeDeferred()
  vi.spyOn(state.ownership, 'settle').mockImplementationOnce(async () => {
    started.resolve()
    await release.promise
  })
  const snapshot = runtime.serializeMainTerminalBuffer(PTY_ID)
  await started.promise
  return { runtime, state, release, snapshot }
}

it('reserves the parsed boundary while ownership settles and preserves later output', async () => {
  const { runtime, state, release, snapshot } = await waitingCapture()
  const write = vi.spyOn(state.emulator, 'write')
  try {
    runtime.onPtyData(PTY_ID, 'LATER\r\n', 2)
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()
    release.resolve()
    const captured = await snapshot
    expect(captured?.seq).toBe('FIRST\r\n'.length)
    expect(captured?.data).toContain('FIRST')
    expect(captured?.data).not.toContain('LATER')
    await state.writeChain
    const next = await runtime.serializeMainTerminalBuffer(PTY_ID)
    expect(next?.seq).toBe('FIRST\r\nLATER\r\n'.length)
    expect(next?.data).toContain('LATER')
  } finally {
    release.resolve()
    await snapshot.catch(() => {})
    await state.writeChain
  }
})

it('returns no snapshot if the model is replaced while ownership settles', async () => {
  const { runtime, state, release, snapshot } = await waitingCapture()
  const capture = vi.spyOn(state.emulator, 'getSnapshot')
  try {
    runtime.notePtyDataGap(PTY_ID)
    runtime.onPtyData(PTY_ID, 'REPLACEMENT', 2)
    await runtime.model().writeChain
    release.resolve()
    await expect(snapshot).resolves.toBeNull()
    expect(capture).not.toHaveBeenCalled()
    const next = await runtime.serializeMainTerminalBuffer(PTY_ID)
    expect(next?.data).toContain('REPLACEMENT')
    expect(next?.data).not.toContain('FIRST')
  } finally {
    release.resolve()
    await snapshot.catch(() => {})
    await state.writeChain
  }
})

it('keeps a later resize behind the reserved snapshot', async () => {
  const { runtime, state, release, snapshot } = await waitingCapture()
  const before = state.emulator.getAppliedSize()
  try {
    runtime.reflowHeadlessTerminalToPtyGrid(PTY_ID, 40, 12)
    await Promise.resolve()
    release.resolve()
    await expect(snapshot).resolves.toMatchObject(before)
    await state.writeChain
    expect(state.emulator.getAppliedSize()).toEqual({ cols: 40, rows: 12 })
  } finally {
    release.resolve()
    await snapshot.catch(() => {})
    await state.writeChain
  }
})

it('does not poison later output after snapshot capture rejects', async () => {
  const runtime = createHydrationRuntime()
  runtime.onPtyData(PTY_ID, 'FIRST', 1)
  await runtime.model().writeChain
  vi.spyOn(runtime.model().emulator, 'getSnapshot').mockImplementationOnce(() => {
    throw new Error('Capture failed')
  })
  await expect(runtime.serializeMainTerminalBuffer(PTY_ID)).rejects.toThrow('Capture failed')
  runtime.onPtyData(PTY_ID, 'LATER', 2)
  const snapshot = await runtime.serializeMainTerminalBuffer(PTY_ID)
  expect(snapshot?.data).toContain('FIRSTLATER')
  expect(snapshot?.seq).toBe('FIRSTLATER'.length)
})

it('does not attach arrival-time metadata from output queued after the capture', async () => {
  const { runtime, state, release, snapshot } = await waitingCapture()
  try {
    runtime.onPtyData(PTY_ID, '\x1b]7;file:///later\x07\x1b]2;LATER-TITLE\x07', 2)
    release.resolve()
    const captured = await snapshot
    expect(captured?.cwd).toBeUndefined()
    expect(captured?.lastTitle).toBeUndefined()
    await state.writeChain
    await expect(runtime.serializeMainTerminalBuffer(PTY_ID)).resolves.toMatchObject({
      cwd: '/later',
      lastTitle: 'LATER-TITLE'
    })
  } finally {
    release.resolve()
    await snapshot.catch(() => {})
    await state.writeChain
  }
})

it('skips capture work retired before the reserved queue link starts', async () => {
  const runtime = createHydrationRuntime()
  runtime.onPtyData(PTY_ID, 'FIRST', 1)
  await runtime.model().writeChain
  const state = runtime.model()
  const started = makeDeferred()
  const release = makeDeferred()
  const originalWrite = state.emulator.write.bind(state.emulator)
  vi.spyOn(state.emulator, 'write').mockImplementationOnce(async (data, options) => {
    started.resolve()
    await release.promise
    await originalWrite(data, options)
  })
  const settle = vi.spyOn(state.ownership, 'settle')
  const capture = vi.spyOn(state.emulator, 'getSnapshot')
  runtime.onPtyData(PTY_ID, 'QUEUED', 2)
  await started.promise
  const snapshot = runtime.serializeMainTerminalBuffer(PTY_ID)
  try {
    runtime.notePtyDataGap(PTY_ID)
    runtime.onPtyData(PTY_ID, 'REPLACEMENT', 3)
    release.resolve()
    await expect(snapshot).resolves.toBeNull()
    expect(settle).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    await state.writeChain
    expect(state.emulator.getVisibleLines().join('')).toContain('FIRSTQUEUED')
  } finally {
    release.resolve()
    await snapshot.catch(() => {})
    await state.writeChain
  }
})
