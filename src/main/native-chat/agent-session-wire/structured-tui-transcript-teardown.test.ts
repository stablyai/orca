import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as Resolver from '../session-file-resolver'
import type * as TranscriptWatch from '../transcript-watch'
import type * as TranscriptTail from '../transcript-tail-reader'
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
      if (gate.mode === 'resolve-error') {
        gate.mode = ''
        throw new Error('transcript read failed')
      }
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

vi.mock('../transcript-tail-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof TranscriptTail>()
  return {
    ...actual,
    readNativeChatTranscriptTailFile: async (
      ...args: Parameters<typeof actual.readNativeChatTranscriptTailFile>
    ) => {
      if (gate.mode === 'initial-ready') {
        gate.mode = ''
        gate.entered.resolve()
        await gate.release.promise
      }
      return actual.readNativeChatTranscriptTailFile(...args)
    }
  }
})

let fixture: Awaited<ReturnType<typeof createTuiTranscriptTeardownFixture>>

beforeEach(async () => {
  gate.mode = ''
  gate.entered = Promise.withResolvers<void>()
  gate.release = Promise.withResolvers<void>()
  fixture = await createTuiTranscriptTeardownFixture()
})

afterEach(async () => {
  gate.release.resolve()
  for (const cleanup of gate.cleanups) {
    cleanup()
  }
  gate.cleanups.clear()
  vi.restoreAllMocks()
})

async function beginTeardown() {
  const stopped = Promise.withResolvers<void>()
  const handoffs = fixture.host['handoffs']
  const stop = handoffs.stopTuiHistoryCatchup.bind(handoffs)
  vi.spyOn(handoffs, 'stopTuiHistoryCatchup').mockImplementation(() => {
    stop()
    stopped.resolve()
  })
  const completed = fixture.host.flushAllStreamedEvents()
  await stopped.promise
  return { completed }
}

it.each(['resolve', 'subscribe', 'initial-ready', 'before-prepare', 'after-prepare'])(
  'cancels transcript acquisition during host teardown at %s',
  async (mode) => {
    gate.mode = mode
    if (mode === 'before-prepare') {
      vi.spyOn(fixture.host.deps.adapter, 'closeSession').mockImplementationOnce(async () => {
        gate.entered.resolve()
        await gate.release.promise
        return true
      })
    } else if (mode === 'after-prepare') {
      const prepare = StructuredTuiTranscriptCatchup.prototype.prepare
      vi.spyOn(StructuredTuiTranscriptCatchup.prototype, 'prepare').mockImplementation(
        async function (this: StructuredTuiTranscriptCatchup, sessionId, fence) {
          const signal = await prepare.call(this, sessionId, fence)
          gate.entered.resolve()
          await gate.release.promise
          return signal
        }
      )
    }
    await fixture.requestHandoff()
    await gate.entered.promise
    const teardown = await beginTeardown()
    gate.release.resolve()
    await teardown.completed
    expect(fixture.host.hasSession(SESSION)).toBe(false)
    expect(getActiveNativeChatWatcherCount()).toBe(fixture.watcherBaseline)
    expect(fixture.launchTui).not.toHaveBeenCalled()
    expect(fixture.acquire).toHaveBeenCalledOnce()
    expect(fixture.host['handoffs']['flowRunner']['active'].size).toBe(0)
    expect(fixture.store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'released',
      handoffStage: 'old-owner-stopped',
      ownerProcess: null,
      reservedSpawnToken: null
    })
  }
)

it('keeps native recovery for an ordinary preparation failure', async () => {
  gate.mode = 'resolve-error'
  const acquire = fixture.acquire.getMockImplementation()
  if (!acquire) {
    throw new Error('Native acquisition fixture missing')
  }
  fixture.acquire.mockImplementationOnce(async (...args) => {
    gate.entered.resolve()
    await gate.release.promise
    return acquire(...args)
  })
  await fixture.requestHandoff()
  await gate.entered.promise
  expect(fixture.acquire).toHaveBeenCalledTimes(2)
  gate.release.resolve()
  await fixture.host['handoffs'].drain()
  expect(fixture.launchTui).not.toHaveBeenCalled()
  expect(fixture.store.getRecord(SESSION)?.lease).toMatchObject({
    runtimeKind: 'native',
    claimStatus: 'live',
    handoffStage: null
  })
  expect((await fixture.host.handoffStatus(SESSION)).error?.details).toBe('transcript read failed')
})

it('cancels recovered TUI catchup without relabeling the live owner or retrying', async () => {
  await fixture.requestHandoff()
  await fixture.host['handoffs'].drain()
  const recover = vi.spyOn(StructuredTuiTranscriptCatchup.prototype, 'recover')
  gate.mode = 'resolve'
  const restoring = fixture.host['handoffs'].restore(SESSION)
  const rejected = expect(restoring).rejects.toBeInstanceOf(StructuredTuiCatchupStoppedError)
  await gate.entered.promise
  const teardown = await beginTeardown()
  gate.release.resolve()
  await rejected
  await teardown.completed
  expect(recover).toHaveBeenCalledOnce()
  expect(getActiveNativeChatWatcherCount()).toBe(fixture.watcherBaseline)
  expect(fixture.acquire).toHaveBeenCalledOnce()
  expect(fixture.store.getRecord(SESSION)?.lease).toMatchObject({
    runtimeKind: 'tui',
    claimStatus: 'live',
    handoffStage: null
  })
})
