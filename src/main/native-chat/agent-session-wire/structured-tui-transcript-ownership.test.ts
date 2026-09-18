import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as Resolver from '../session-file-resolver'
import type * as TranscriptWatch from '../transcript-watch'
import { getActiveNativeChatWatcherCount } from '../transcript-watcher-count'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { StructuredTuiTranscriptCatchup } from './structured-tui-transcript-catchup'
import { StructuredTuiCatchupStoppedError } from './structured-agent-session-handoff-types'
import { createTuiTranscriptTeardownFixture } from './structured-tui-transcript-teardown-test-fixture'

const gate = vi.hoisted(() => ({
  mode: '',
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  cleanups: new Set<() => void>()
}))

vi.mock('../session-file-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof Resolver>()
  return {
    ...actual,
    resolveSessionFilePath: async (...args: Parameters<typeof actual.resolveSessionFilePath>) => {
      if (gate.mode === 'resolve') {
        gate.mode = ''
        gate.entered.resolve()
        await gate.release.promise
      }
      return actual.resolveSessionFilePath(...args)
    }
  }
})

vi.mock('../transcript-watch', async (importOriginal) => {
  const actual = await importOriginal<typeof TranscriptWatch>()
  return {
    ...actual,
    subscribeNativeChatTranscript: async (
      ...args: Parameters<typeof actual.subscribeNativeChatTranscript>
    ) => {
      const subscription = await actual.subscribeNativeChatTranscript(...args)
      gate.cleanups.add(subscription.unsubscribe)
      if (gate.mode === 'subscribe') {
        gate.mode = ''
        gate.entered.resolve()
        await gate.release.promise
      }
      return subscription
    }
  }
})

let fixture: Awaited<ReturnType<typeof createTuiTranscriptTeardownFixture>>
let catchup: StructuredTuiTranscriptCatchup

beforeEach(async () => {
  gate.mode = ''
  gate.entered = Promise.withResolvers<void>()
  gate.release = Promise.withResolvers<void>()
  fixture = await createTuiTranscriptTeardownFixture()
  catchup = new StructuredTuiTranscriptCatchup({
    store: fixture.store,
    session: (sessionId) => {
      const session = fixture.host['sessions'].get(sessionId)
      if (!session) {
        throw new Error('Session fixture missing')
      }
      return session
    },
    schedule: (_sessionId, task) => task(),
    publish: vi.fn(),
    reset: vi.fn()
  })
})

afterEach(() => {
  gate.release.resolve()
  catchup.stopAll()
  for (const cleanup of gate.cleanups) {
    cleanup()
  }
  gate.cleanups.clear()
  vi.restoreAllMocks()
})

it.each([
  { method: 'prepare', mode: 'resolve' },
  { method: 'prepare', mode: 'subscribe' },
  { method: 'recover', mode: 'resolve' },
  { method: 'recover', mode: 'subscribe' }
] as const)(
  'preserves replacement ownership after canceled $method at $mode completes',
  async ({ method, mode }) => {
    gate.mode = mode
    const old = catchup[method](SESSION, 1)
    const rejected = expect(old).rejects.toBeInstanceOf(StructuredTuiCatchupStoppedError)
    await gate.entered.promise
    const replacement = await catchup[method === 'prepare' ? 'recover' : 'prepare'](SESSION, 2)
    gate.release.resolve()
    await rejected
    expect(replacement.aborted).toBe(false)
    expect(catchup['states'].get(SESSION)?.fence).toBe(2)
    expect(getActiveNativeChatWatcherCount()).toBe(fixture.watcherBaseline + 1)
    catchup.stop(SESSION)
    expect(replacement.aborted).toBe(true)
    expect(getActiveNativeChatWatcherCount()).toBe(fixture.watcherBaseline)
  }
)

it('allows a new per-session catchup after stop but rejects every start after stopAll', async () => {
  const first = await catchup.prepare(SESSION, 1)
  catchup.stop(SESSION)
  expect(first.aborted).toBe(true)
  const replacement = await catchup.prepare(SESSION, 2)
  expect(replacement.aborted).toBe(false)
  catchup.stopAll()
  catchup.stopAll()
  await expect(catchup.prepare(SESSION, 3)).rejects.toBeInstanceOf(StructuredTuiCatchupStoppedError)
  await expect(catchup.recover(SESSION, 3)).rejects.toBeInstanceOf(StructuredTuiCatchupStoppedError)
  expect(catchup['states'].size).toBe(0)
  expect(getActiveNativeChatWatcherCount()).toBe(fixture.watcherBaseline)
})

it('fences an unsupported preparation result when teardown runs before its consumer', async () => {
  vi.spyOn(fixture.store, 'getRecord').mockReturnValueOnce(null)
  const prepared = await catchup.prepare(SESSION, 1)
  expect(prepared.aborted).toBe(false)
  expect(catchup['states'].size).toBe(0)
  catchup.stopAll()
  expect(() => prepared.throwIfAborted()).toThrow(StructuredTuiCatchupStoppedError)
  expect(getActiveNativeChatWatcherCount()).toBe(fixture.watcherBaseline)
})
