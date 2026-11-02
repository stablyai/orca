import { afterEach, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../agent-session-timeline/provider-timeline-assembler-test-support'
import { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'

function queue(onFailed?: (error: unknown) => void) {
  return new StructuredAgentSessionSinkQueue({
    watermarks: {
      pauseQueuedBytes: 16 * 1024 * 1024,
      lowQueuedBytes: 8 * 1024 * 1024,
      pauseQueuedOperations: 512,
      lowQueuedOperations: 256
    },
    onFailed
  })
}

afterEach(closeProviderTimelineRigs)

it('fails before retaining more than the pre-control byte limit and fails its barriers', async () => {
  const failures: unknown[] = []
  const sink = queue((error) => failures.push(error))
  expect(sink.submit({ bytes: 32 * 1024 * 1024, run: () => {} })).toEqual({ accepted: true })
  const barrier = sink.barrier()
  expect(sink.submit({ bytes: 1, run: () => {} })).toEqual({
    accepted: false,
    reason: 'failed'
  })
  expect(sink.state()).toMatchObject({ failed: true, queuedBytes: 0, queuedOperations: 0 })
  await expect(barrier).resolves.toMatchObject({ ok: false })
  expect(sink.submit({ bytes: 1, run: () => {} }).accepted).toBe(false)
  expect(failures).toHaveLength(1)
})

it('releases replaced buffered publications from the pre-control budget', async () => {
  const sink = queue()
  for (let index = 0; index < 2_048; index++) {
    expect(
      sink.submit({ bytes: 32 * 1024 * 1024, publicationKey: 'status', run: () => {} })
    ).toEqual({ accepted: true })
  }
  expect(sink.state()).toMatchObject({ failed: false, queuedOperations: 1 })
  sink.close()
  await expect(sink.barrier()).resolves.toEqual({ ok: true })
})

it('bounds superseded publications still retained on a blocked journal lane', async () => {
  const rig = await openProviderTimelineRig()
  const sink = queue()
  sink.bind({ journal: rig.journal, fence: 1, publish: () => {} })
  const gate = Promise.withResolvers<void>()
  const blocked = rig.journal.readInOrder(() => {
    for (let index = 0; index < 1_024; index++) {
      expect(sink.submit({ bytes: 1, publicationKey: 'status', run: () => {} })).toEqual({
        accepted: true
      })
    }
    expect(sink.state()).toMatchObject({ queuedOperations: 1_024, failed: false })
    expect(sink.submit({ bytes: 1, publicationKey: 'status', run: () => {} })).toEqual({
      accepted: false,
      reason: 'failed'
    })
    return gate.promise
  })
  try {
    gate.resolve()
    await blocked
  } finally {
    gate.resolve()
    await sink.barrier()
  }
  expect(sink.state()).toMatchObject({ queuedOperations: 0, queuedBytes: 0, failed: true })
})

it('paces superseded publications after reading control binds and publishes only the latest', async () => {
  const rig = await openProviderTimelineRig()
  const sink = queue()
  const control = { pauseReading: vi.fn(), resumeReading: vi.fn() }
  sink.bindReadingControl(control)
  sink.bind({ journal: rig.journal, fence: 1, publish: () => {} })
  const published: number[] = []
  const gate = Promise.withResolvers<void>()
  const blocked = rig.journal.readInOrder(() => {
    for (let index = 0; index < 1_025; index++) {
      expect(
        sink.submit({ bytes: 1, publicationKey: 'status', run: () => void published.push(index) })
      ).toEqual({ accepted: true })
    }
    return gate.promise
  })
  try {
    expect(control.pauseReading).toHaveBeenCalledOnce()
    expect(control.resumeReading).not.toHaveBeenCalled()
    expect(sink.state()).toMatchObject({ queuedOperations: 1_025, failed: false })
    gate.resolve()
    await blocked
    await expect(sink.barrier()).resolves.toEqual({ ok: true })
    expect(published).toEqual([1_024])
    expect(sink.state()).toMatchObject({ queuedBytes: 0, queuedOperations: 0 })
    expect(control.resumeReading).toHaveBeenCalledOnce()
  } finally {
    gate.resolve()
    await sink.barrier()
    sink.close()
  }
})

it.each([
  { limit: 'operations', count: 1_025, bytes: 1 },
  { limit: 'bytes', count: 1, bytes: 33 * 1024 * 1024 }
])(
  'drains final writes past the startup $limit limit after control unbinds',
  async ({ count, bytes }) => {
    const rig = await openProviderTimelineRig()
    const sink = queue()
    const control = { pauseReading: vi.fn(), resumeReading: vi.fn() }
    const unbind = sink.bindReadingControl(control)
    const written: number[] = []
    for (let index = 0; index < count; index++) {
      expect(sink.submit({ bytes, run: () => void written.push(index) })).toEqual({
        accepted: true
      })
    }
    expect(control.pauseReading).toHaveBeenCalledOnce()
    unbind()

    expect(sink.submit({ bytes: 1, run: () => void written.push(count) })).toEqual({
      accepted: true
    })
    sink.bind({ journal: rig.journal, fence: 1, publish: () => {} })
    await expect(sink.written()).resolves.toEqual({ ok: true })
    expect(written).toEqual(Array.from({ length: count + 1 }, (_, index) => index))
    expect(sink.state()).toMatchObject({ failed: false, queuedBytes: 0, queuedOperations: 0 })
    expect(control.resumeReading).not.toHaveBeenCalled()
    sink.close()
  }
)

it('reclaims the pre-control budget after writes settle', async () => {
  const rig = await openProviderTimelineRig()
  const sink = queue()
  sink.bind({ journal: rig.journal, fence: 1, publish: () => {} })
  const written: number[] = []
  for (let index = 0; index < 2; index++) {
    expect(sink.submit({ bytes: 32 * 1024 * 1024, run: () => void written.push(index) })).toEqual({
      accepted: true
    })
    await expect(sink.barrier()).resolves.toEqual({ ok: true })
    expect(sink.state()).toMatchObject({ queuedBytes: 0, queuedOperations: 0 })
  }
  expect(written).toEqual([0, 1])
  sink.close()
})
