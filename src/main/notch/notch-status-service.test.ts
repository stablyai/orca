import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload, AgentStatusState } from '../../shared/agent-status-types'
import { NotchStatusService, type NotchStatusSource } from './notch-status-service'

// receivedAt defaults to now so fixtures aren't treated as long-silent agents; stateStartedAt
// stays caller-controlled because the acknowledgement rule compares against it.
function payload(
  paneKey: string,
  state: AgentStatusState,
  stateStartedAt = 1_000,
  receivedAt = Date.now()
): AgentStatusIpcPayload {
  return {
    paneKey,
    state,
    prompt: '',
    connectionId: null,
    receivedAt,
    stateStartedAt
  } as AgentStatusIpcPayload
}

function makeSource(initial: AgentStatusIpcPayload[]) {
  let snapshot = initial
  const enriched: (() => void)[] = []
  const cleared: (() => void)[] = []
  const source: NotchStatusSource = {
    getStatusSnapshot: () => snapshot,
    subscribeEnrichedStatus: (listener) => {
      enriched.push(listener as () => void)
      return () => undefined
    },
    subscribePaneStatusClear: (listener) => {
      cleared.push(listener as () => void)
      return () => undefined
    }
  }
  return {
    source,
    setSnapshot: (next: AgentStatusIpcPayload[]) => {
      snapshot = next
    },
    emitStatus: () => enriched.forEach((fn) => fn()),
    emitClear: () => cleared.forEach((fn) => fn())
  }
}

// Flush synchronously so tests don't depend on timers.
const immediateFlush = (flush: () => void): (() => void) => {
  flush()
  return () => undefined
}

afterEach(() => {
  vi.useRealTimers()
})

describe('NotchStatusService', () => {
  it('publishes a summary from the initial snapshot on start', () => {
    const { source } = makeSource([payload('t1:a', 'working')])
    const service = new NotchStatusService({ source, scheduleFlush: immediateFlush })
    service.start()

    expect(service.getSummary().counts).toEqual({ working: 1, attention: 0, done: 0 })
  })

  it('recomputes from the snapshot when a status event fires', () => {
    const harness = makeSource([payload('t1:a', 'working')])
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush
    })
    service.start()

    harness.setSnapshot([payload('t1:a', 'blocked')])
    harness.emitStatus()

    expect(service.getSummary().counts).toEqual({ working: 0, attention: 1, done: 0 })
  })

  it('treats a clear as a trigger and re-reads the snapshot', () => {
    // Why: removals arrive on a different channel than updates; recomputing means the two
    // can never disagree about what the bar shows.
    const harness = makeSource([payload('t1:a', 'working')])
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush
    })
    service.start()

    harness.setSnapshot([])
    harness.emitClear()

    expect(service.getSummary().counts.working).toBe(0)
    expect(service.getSummary().sessions).toEqual([])
  })

  it('notifies subscribers only when the summary actually changes', () => {
    const harness = makeSource([payload('t1:a', 'working')])
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush
    })
    service.start()

    const listener = vi.fn()
    service.subscribe(listener)

    harness.emitStatus()
    expect(listener).not.toHaveBeenCalled()

    harness.setSnapshot([payload('t1:a', 'done')])
    harness.emitStatus()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('drops a done pane from the green lane once acknowledged', () => {
    const harness = makeSource([payload('t1:a', 'done', 5_000)])
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush
    })
    service.start()
    expect(service.getSummary().counts.done).toBe(1)

    service.acknowledgePanes(['t1:a'], 6_000)

    expect(service.getSummary().counts.done).toBe(0)
  })

  it('ignores an acknowledgement older than one already recorded', () => {
    const harness = makeSource([payload('t1:a', 'done', 5_000)])
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush
    })
    service.start()
    service.acknowledgePanes(['t1:a'], 6_000)
    service.acknowledgePanes(['t1:a'], 1_000)

    expect(service.getSummary().counts.done).toBe(0)
  })

  it('re-counts an acknowledged pane when the agent finishes a later turn', () => {
    const harness = makeSource([payload('t1:a', 'done', 5_000)])
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush
    })
    service.start()
    service.acknowledgePanes(['t1:a'], 6_000)
    expect(service.getSummary().counts.done).toBe(0)

    harness.setSnapshot([payload('t1:a', 'done', 9_000)])
    harness.emitStatus()

    expect(service.getSummary().counts.done).toBe(1)
  })

  it('forgets acknowledgements for panes that no longer exist', () => {
    // Why: pane keys get reused, and a stale ack would suppress the next agent's green.
    const harness = makeSource([payload('t1:a', 'done', 5_000)])
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush
    })
    service.start()
    // Ack deliberately later than the reused pane's start, so only real pruning can clear it.
    service.acknowledgePanes(['t1:a'], 9_000)

    harness.setSnapshot([])
    harness.emitClear()
    harness.setSnapshot([payload('t1:a', 'done', 7_000)])
    harness.emitStatus()

    expect(service.getSummary().counts.done).toBe(1)
  })

  it('coalesces a burst of events into one recompute', () => {
    const harness = makeSource([payload('t1:a', 'working')])
    const flushes: (() => void)[] = []
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: (flush) => {
        flushes.push(flush)
        return () => undefined
      }
    })
    service.start()

    harness.emitStatus()
    harness.emitStatus()
    harness.emitStatus()

    expect(flushes).toHaveLength(1)
  })

  it('survives a throwing subscriber', () => {
    const harness = makeSource([payload('t1:a', 'working')])
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush
    })
    service.start()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    service.subscribe(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    service.subscribe(good)

    harness.setSnapshot([payload('t1:a', 'done')])
    harness.emitStatus()

    expect(good).toHaveBeenCalledTimes(1)
  })

  it('publishes when only a session identity changes', () => {
    // Why: lane and counts stay identical when a pane is re-attributed, but the row's label and
    // click target both change — skipping the publish leaves a row routing to the old pane.
    const harness = makeSource([
      { ...payload('t1:a', 'working'), worktreeId: 'repo::/w/one' } as AgentStatusIpcPayload
    ])
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush
    })
    service.start()
    const listener = vi.fn()
    service.subscribe(listener)

    harness.setSnapshot([
      { ...payload('t1:a', 'working'), worktreeId: 'repo::/w/two' } as AgentStatusIpcPayload
    ])
    harness.emitStatus()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(service.getSummary().sessions[0].worktreeId).toBe('repo::/w/two')
  })

  it('publishes when a session changes agent type', () => {
    const harness = makeSource([
      { ...payload('t1:a', 'working'), agentType: 'claude' } as AgentStatusIpcPayload
    ])
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush
    })
    service.start()
    const listener = vi.fn()
    service.subscribe(listener)

    harness.setSnapshot([
      { ...payload('t1:a', 'working'), agentType: 'codex' } as AgentStatusIpcPayload
    ])
    harness.emitStatus()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('re-evaluates staleness on the ticker with no new events', () => {
    // Why: a killed agent sends nothing further, so only elapsed time can retire its row.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(60_000))
    const harness = makeSource([payload('t1:a', 'working', 1_000, 60_000)])
    let tick: (() => void) | undefined
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush,
      startStaleTicker: (fn: () => void) => {
        tick = fn
        return () => undefined
      }
    })
    service.start()
    expect(service.getSummary().counts.working).toBe(1)

    vi.setSystemTime(new Date(60_000 + 31 * 60_000))
    tick?.()

    expect(service.getSummary().counts.working).toBe(0)
  })

  it('stops the stale ticker on stop()', () => {
    const harness = makeSource([payload('t1:a', 'working')])
    const stopTicker = vi.fn()
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush,
      startStaleTicker: () => stopTicker
    })
    service.start()
    service.stop()

    expect(stopTicker).toHaveBeenCalledTimes(1)
  })

  it('stops publishing after stop()', () => {
    const harness = makeSource([payload('t1:a', 'working')])
    const service = new NotchStatusService({
      source: harness.source,
      scheduleFlush: immediateFlush
    })
    service.start()
    const listener = vi.fn()
    service.subscribe(listener)
    service.stop()

    harness.setSnapshot([payload('t1:a', 'done')])
    harness.emitStatus()

    expect(listener).not.toHaveBeenCalled()
  })
})
