import { expect, it, vi } from 'vitest'

import type { PtyProviderBufferSnapshot } from '../providers/pty-provider-contract'
import { deferred, syncSinglePty } from './orca-runtime-tests/orca-runtime-test-fixtures.spec'
import {
  createHydrationRuntime,
  PTY_ID,
  RETIRED_SNAPSHOT,
  retire,
  SIZE
} from './orca-runtime-tests/headless-hydration-ownership-test-fixture'

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
