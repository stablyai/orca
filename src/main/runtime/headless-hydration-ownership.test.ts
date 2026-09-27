import { expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { deferred, makeDeferred } from './orca-runtime-test-fixtures.spec'
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
    expect(runtime.retainedState().hydration).toBe(
      outcome === 'success' ? 'done' : 'awaiting-serializer'
    )
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
  const write = vi.spyOn(HeadlessEmulator.prototype, 'write').mockImplementationOnce(async () => {
    started.resolve()
    await release.promise
  })
  await vi.waitFor(() => expect(serialize).toHaveBeenCalledOnce())
  snapshot.resolve(RETIRED_SNAPSHOT)
  await started.promise
  const candidate = write.mock.contexts[0]
  if (!(candidate instanceof HeadlessEmulator)) {
    throw new Error('Expected a staged headless emulator')
  }
  expect(candidate).not.toBe(old.emulator)
  const dispose = vi.spyOn(candidate, 'dispose')
  retire(runtime)
  release.resolve()
  await old.writeChain
  expect(dispose).toHaveBeenCalledOnce()
  expect(runtime.retainedState()).toEqual(EMPTY_RETAINED_STATE)
})
