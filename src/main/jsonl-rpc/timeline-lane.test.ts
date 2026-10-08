import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  refusingSink,
  SESSION,
  GENERATION,
  NAMESPACE
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { JsonlRpcTimelineLane } from './timeline-lane'

const lanes: JsonlRpcTimelineLane[] = []
afterEach(async () => {
  for (const lane of lanes.splice(0)) {
    lane.dispose()
  }
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

async function rig() {
  const journal = await openProviderTimelineRig({ agent: 'pi' })
  let blocked = true
  const pauseReading = vi.fn(),
    resumeReading = vi.fn(),
    onInputAccepted = vi.fn(),
    onFailed = vi.fn()
  const lane = new JsonlRpcTimelineLane({
    sink: refusingSink(journal.sink, () => blocked),
    sessionId: SESSION,
    agent: 'pi',
    generation: GENERATION,
    namespace: NAMESPACE,
    pauseReading,
    resumeReading,
    onInputAccepted,
    onFailed
  })
  lanes.push(lane)
  return {
    journal,
    lane,
    pauseReading,
    resumeReading,
    onInputAccepted,
    onFailed,
    unblock: () => {
      blocked = false
    }
  }
}

describe('JSON-lines timeline admission', () => {
  it('admits the final tail with the host settlement budget when ordinary writes are full', async () => {
    const journal = await openProviderTimelineRig({ agent: 'pi' })
    const lane = new JsonlRpcTimelineLane({
      sink: {
        ...journal.sink,
        tryAppendTransition: (transition) =>
          transition.lifecycle
            ? journal.sink.tryAppendTransition(transition)
            : { accepted: false, reason: 'backpressure' }
      },
      sessionId: SESSION,
      agent: 'pi',
      generation: GENERATION,
      namespace: NAMESPACE,
      pauseReading: vi.fn(),
      resumeReading: vi.fn(),
      onInputAccepted: vi.fn(),
      onFailed: vi.fn()
    })
    lanes.push(lane)
    lane.apply([
      {
        type: 'item.update',
        item: 'final',
        body: { kind: 'status', tone: 'info', text: 'Final tail' }
      }
    ])
    expect(await journal.rows()).toEqual([])
    lane.finalize()
    await lane.drained()
    expect(await journal.rows()).toEqual([
      expect.objectContaining({ body: { kind: 'status', tone: 'info', text: 'Final tail' } })
    ])
  })

  it('holds an entire parsed batch and accepts input only after journal admission', async () => {
    const test = await rig()
    test.lane.apply([
      { type: 'turn.open', turn: 'run:1', at: 1 },
      { type: 'input.accepted', clientMessageId: 'message:1', requestedAt: 1 },
      { type: 'turn.end', at: 2, state: 'completed', outcome: 'success' }
    ])
    expect(test.pauseReading).toHaveBeenCalled()
    expect(test.onInputAccepted).not.toHaveBeenCalled()
    expect(await test.journal.turns()).toEqual([])
    test.unblock()
    test.lane.retry()
    await test.lane.drained()
    expect(test.onInputAccepted).toHaveBeenCalledExactlyOnceWith('message:1')
    expect(test.resumeReading).toHaveBeenCalled()
    expect(await test.journal.turns()).toHaveLength(1)
    expect((await test.journal.turns())[0]).toMatchObject({
      state: 'completed',
      outcome: 'success'
    })
  })

  it('retries paused input and clears its timer after draining', async () => {
    const test = await rig()
    vi.useFakeTimers()
    test.lane.apply([{ type: 'turn.open', turn: 'run:1', at: 1 }])
    test.unblock()
    await vi.advanceTimersByTimeAsync(250)
    await test.lane.drained()
    expect(test.lane.openTurnId).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds data already parsed in a batch after the reader pauses', async () => {
    const test = await rig()
    test.lane.apply(
      Array.from({ length: 257 }, (_, index) => ({
        type: 'item.close',
        item: `item:${index}`,
        body: { kind: 'status', tone: 'info', text: 'held' }
      }))
    )
    expect(test.onFailed).toHaveBeenCalledExactlyOnceWith('Agent timeline queue capacity exceeded')
    await expect(test.lane.drained()).resolves.toBeUndefined()
    expect(test.onInputAccepted).not.toHaveBeenCalled()
  })

  it('releases drain and turn waiters when a failed lane is disposed', async () => {
    const test = await rig()
    test.unblock()
    test.lane.apply([{ type: 'turn.open', turn: 'run:1', at: 1 }])
    const turn = test.lane.openTurnId
    expect(turn).not.toBeNull()
    const waiting = test.lane.whenTurnLeaves(turn!)
    test.lane.dispose()
    await expect(waiting).resolves.toBeUndefined()
  })
})
