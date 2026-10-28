import { expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import type { PtyProviderBufferSnapshot } from '../providers/pty-provider-contract'
import { deferred, makeDeferred, syncSinglePty } from './orca-runtime-test-fixtures.spec'
import {
  createHydrationRuntime,
  EMPTY_RETAINED_STATE,
  PTY_ID,
  RETIRED_SNAPSHOT,
  retire,
  SIZE
} from './headless-hydration-ownership-test-fixture'

type Snapshot = typeof RETIRED_SNAPSHOT | null

function prepare() {
  const runtime = createHydrationRuntime()
  const snapshot = deferred<Snapshot>()
  const serialize = vi.fn(() => snapshot.promise)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => SIZE,
    hasRendererSerializer: () => true,
    serializeBuffer: serialize
  })
  return { runtime, snapshot, serialize }
}

it('does not start renderer hydration after the model retires before its callback', async () => {
  const { runtime, snapshot, serialize } = prepare()
  runtime.onPtyData(PTY_ID, 'queued-live', 1)
  const old = runtime.model()
  const write = vi.spyOn(old.emulator, 'write')
  retire(runtime)
  snapshot.resolve(RETIRED_SNAPSHOT)
  await old.writeChain
  expect(serialize).not.toHaveBeenCalled()
  expect(write).toHaveBeenCalledWith('queued-live', { forwardQueryReplies: false })
  expect(runtime.retainedState()).toEqual(EMPTY_RETAINED_STATE)
})

it.each(['success', 'null', 'reject'] as const)(
  'does not resurrect retired renderer-hydration state after %s',
  async (outcome) => {
    const { runtime, snapshot, serialize } = prepare()
    runtime.onPtyData(PTY_ID, 'queued-live', 1)
    const old = runtime.model()
    await vi.waitFor(() => expect(serialize).toHaveBeenCalledOnce())
    retire(runtime)
    if (outcome === 'reject') {
      snapshot.reject(new Error('Renderer unavailable'))
    } else {
      snapshot.resolve(outcome === 'success' ? RETIRED_SNAPSHOT : null)
    }
    await old.writeChain
    expect(runtime.retainedState()).toEqual(EMPTY_RETAINED_STATE)
  }
)

it.each(['success', 'null', 'reject'] as const)(
  'settles current renderer hydration after %s and preserves queued live bytes',
  async (outcome) => {
    const { runtime, snapshot } = prepare()
    runtime.onPtyData(PTY_ID, 'CURRENT-LIVE', 1)
    const current = runtime.model()
    if (outcome === 'reject') {
      snapshot.reject(new Error('Renderer unavailable'))
    } else {
      snapshot.resolve(outcome === 'success' ? RETIRED_SNAPSHOT : null)
    }
    await current.writeChain
    expect(runtime.retainedState().hydration).toBe('done')
    expect(current.emulator.getVisibleLines().join('\n')).toContain('CURRENT-LIVE')
    expect(current.emulator.getVisibleLines().join('\n').includes('RETIRED-SEED')).toBe(
      outcome === 'success'
    )
  }
)

it('keeps a same-ID replacement pending when an old renderer snapshot arrives', async () => {
  const { runtime, snapshot, serialize } = prepare()
  runtime.onPtyData(PTY_ID, 'OLD-LIVE', 1)
  const old = runtime.model()
  await vi.waitFor(() => expect(serialize).toHaveBeenCalledOnce())
  runtime.notePtyDataGap(PTY_ID)
  const replacementSnapshot = deferred<Snapshot>()
  serialize.mockImplementation(() => replacementSnapshot.promise)
  runtime.onPtyData(PTY_ID, 'NEW-LIVE', 2)
  const replacement = runtime.model()
  runtime.preferProvider()
  await vi.waitFor(() => expect(serialize).toHaveBeenCalledTimes(2))
  snapshot.resolve(RETIRED_SNAPSHOT)
  await old.writeChain
  expect(runtime.model()).toBe(replacement)
  expect(runtime.retainedState()).toMatchObject({ hydration: 'pending', providerPreferred: true })
  expect(runtime.retainedState().cwd).toBeUndefined()
  replacementSnapshot.resolve({ ...RETIRED_SNAPSHOT, data: 'NEW-SEED', lastTitle: 'New title' })
  await replacement.writeChain
  const text = replacement.emulator.getVisibleLines().join('\n')
  expect(text).toContain('NEW-SEEDNEW-LIVE')
  expect(text).not.toContain('OLD-LIVE')
  expect(text).not.toContain('RETIRED-SEED')
  expect(runtime.retainedState()).toMatchObject({ hydration: 'done', providerPreferred: false })
})

it('skips late title and completion bookkeeping after disposal during the seed write', async () => {
  const { runtime, snapshot, serialize } = prepare()
  runtime.onPtyData(PTY_ID, 'queued-live', 1)
  const old = runtime.model()
  const started = makeDeferred()
  const release = makeDeferred()
  const original = old.emulator.write.bind(old.emulator)
  vi.spyOn(old.emulator, 'write').mockImplementationOnce(async (data) => {
    started.resolve()
    await release.promise
    return original(data)
  })
  await vi.waitFor(() => expect(serialize).toHaveBeenCalledOnce())
  snapshot.resolve(RETIRED_SNAPSHOT)
  await started.promise
  retire(runtime)
  release.resolve()
  await old.writeChain
  expect(runtime.retainedState()).toEqual(EMPTY_RETAINED_STATE)
})

const PROVIDER_SNAPSHOT: PtyProviderBufferSnapshot = {
  ...SIZE,
  data: 'PROVIDER-SEED',
  cwd: '/retired-context',
  seq: 0,
  source: 'headless',
  alternateScreen: false
}

function prepareProvider() {
  const runtime = createHydrationRuntime()
  const snapshot = deferred<PtyProviderBufferSnapshot | null>()
  const serialize = vi.fn(() => snapshot.promise)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => SIZE,
    serializeProviderBuffer: serialize
  })
  return { runtime, snapshot, serialize }
}

it('skips an initial seed retired before its callback without clearing the replacement preference', async () => {
  const runtime = createHydrationRuntime()
  runtime.seedHeadlessTerminal(PTY_ID, 'OLD-SEED')
  const old = runtime.model()
  const write = vi.spyOn(old.emulator, 'write')
  runtime.notePtyDataGap(PTY_ID)
  runtime.onPtyData(PTY_ID, 'NEW-LIVE', 1)
  const replacement = runtime.model()
  runtime.preferProvider()
  await old.writeChain
  await replacement.writeChain
  expect(write).not.toHaveBeenCalled()
  expect(runtime.retainedState().providerPreferred).toBe(true)
  expect(replacement.emulator.getVisibleLines().join('\n')).toContain('NEW-LIVE')
})

it.each(['write', 'kitty'] as const)(
  'keeps replacement ownership when an initial seed awaits %s',
  async (stage) => {
    const runtime = createHydrationRuntime()
    runtime.seedHeadlessTerminal(PTY_ID, 'OLD-SEED', SIZE, { kittyKeyboardFlags: 3 })
    const old = runtime.model()
    const started = makeDeferred()
    const release = makeDeferred()
    if (stage === 'write') {
      const original = old.emulator.write.bind(old.emulator)
      vi.spyOn(old.emulator, 'write').mockImplementationOnce(async (data) => {
        started.resolve()
        await release.promise
        return original(data)
      })
    } else {
      const original = old.emulator.applyKittyKeyboardFlags.bind(old.emulator)
      vi.spyOn(old.emulator, 'applyKittyKeyboardFlags').mockImplementationOnce(async (flags) => {
        started.resolve()
        await release.promise
        return original(flags)
      })
    }
    await started.promise
    runtime.notePtyDataGap(PTY_ID)
    runtime.onPtyData(PTY_ID, 'NEW-LIVE', 1)
    runtime.preferProvider()
    release.resolve()
    await old.writeChain
    expect(runtime.retainedState().providerPreferred).toBe(true)
  }
)

it('preserves current seed metadata and ordered live output', async () => {
  const runtime = createHydrationRuntime()
  runtime.seedHeadlessTerminal(PTY_ID, 'SEED-', SIZE, { cwd: '/current', kittyKeyboardFlags: 3 })
  runtime.onPtyData(PTY_ID, 'LIVE', 1)
  await runtime.model().writeChain
  const snapshot = runtime.model().emulator.getSnapshot()
  expect(snapshot.snapshotAnsi).toContain('SEED-LIVE')
  expect(snapshot.cwd).toBe('/current')
  expect(snapshot.modes.kittyKeyboardFlags).toBe(3)
})

it('does not acquire a provider snapshot for a model retired before its callback', async () => {
  const { runtime, snapshot, serialize } = prepareProvider()
  runtime.replaceExecutionContext()
  const old = runtime.model()
  retire(runtime)
  snapshot.resolve(PROVIDER_SNAPSHOT)
  await old.writeChain
  expect(serialize).not.toHaveBeenCalled()
  expect(runtime.retainedState()).toEqual(EMPTY_RETAINED_STATE)
})

it.each(['success', 'null', 'reject'] as const)(
  'does not retain provider state after a retired acquisition returns %s',
  async (outcome) => {
    const { runtime, snapshot, serialize } = prepareProvider()
    runtime.replaceExecutionContext()
    const old = runtime.model()
    await vi.waitFor(() => expect(serialize).toHaveBeenCalledOnce())
    retire(runtime)
    if (outcome === 'reject') {
      snapshot.reject(new Error('Provider unavailable'))
    } else {
      snapshot.resolve(outcome === 'success' ? PROVIDER_SNAPSHOT : null)
    }
    await old.writeChain
    expect(runtime.retainedState()).toEqual(EMPTY_RETAINED_STATE)
  }
)

it('refuses a stale context seed after model replacement within the same PTY generation', async () => {
  const { runtime, snapshot, serialize } = prepareProvider()
  runtime.replaceExecutionContext()
  const old = runtime.model()
  await vi.waitFor(() => expect(serialize).toHaveBeenCalledOnce())
  runtime.notePtyDataGap(PTY_ID)
  runtime.onPtyData(PTY_ID, 'NEW-LIVE', 1)
  const replacement = runtime.model()
  runtime.preferProvider()
  snapshot.resolve(PROVIDER_SNAPSHOT)
  await old.writeChain
  expect(runtime.model()).toBe(replacement)
  expect(runtime.retainedState()).toMatchObject({ cwd: undefined, providerPreferred: true })
})

it('does not reinsert provider CWD after disposal during its seed write', async () => {
  const { runtime, snapshot } = prepareProvider()
  runtime.replaceExecutionContext()
  const old = runtime.model()
  const started = makeDeferred()
  const release = makeDeferred()
  const original = old.emulator.write.bind(old.emulator)
  vi.spyOn(old.emulator, 'write').mockImplementationOnce(async (data) => {
    started.resolve()
    await release.promise
    return original(data)
  })
  snapshot.resolve(PROVIDER_SNAPSHOT)
  await started.promise
  retire(runtime)
  release.resolve()
  await old.writeChain
  expect(runtime.retainedState()).toEqual(EMPTY_RETAINED_STATE)
})

it('keeps the replacement capture generation and live-mode scan after an old capture settles', async () => {
  const { runtime, snapshot, serialize } = prepareProvider()
  const old = runtime.captureProvider()
  const oldGeneration = runtime.retainedState().generation
  retire(runtime)
  syncSinglePty(runtime, PTY_ID)
  const replacementSnapshot = deferred<PtyProviderBufferSnapshot | null>()
  serialize.mockImplementation(() => replacementSnapshot.promise)
  const replacement = runtime.captureProvider()
  const newGeneration = runtime.retainedState().generation
  expect(newGeneration).not.toBe(oldGeneration)
  snapshot.resolve(PROVIDER_SNAPSHOT)
  await expect(old).resolves.toBeNull()
  expect(runtime.retainedState()).toMatchObject({ generation: newGeneration, snapshotScans: 1 })
  runtime.onPtyData(PTY_ID, '\x1b[?1049h', 1)
  replacementSnapshot.resolve(PROVIDER_SNAPSHOT)
  await expect(replacement).resolves.toMatchObject({ alternateScreen: true })
  expect(runtime.retainedState().snapshotScans).toBe(0)
})

it.each([false, true])(
  'does not remint a retired generation after parsing a provider tail, visible-only: %s',
  async (visibleOnly) => {
    const { runtime, snapshot } = prepareProvider()
    const started = makeDeferred()
    const release = makeDeferred()
    const original = HeadlessEmulator.prototype.write
    vi.spyOn(HeadlessEmulator.prototype, 'write').mockImplementationOnce(async function (
      this: HeadlessEmulator,
      data,
      options
    ) {
      started.resolve()
      await release.promise
      return original.call(this, data, options)
    })
    const read = runtime.providerTail(visibleOnly)
    snapshot.resolve(PROVIDER_SNAPSHOT)
    await started.promise
    retire(runtime)
    release.resolve()
    await expect(read).resolves.toEqual({ lines: [] })
    expect(runtime.retainedState()).toEqual(EMPTY_RETAINED_STATE)
  }
)
