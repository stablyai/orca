import { describe, expect, it } from 'vitest'
import {
  RealtimeResponseGate,
  tagResponseCreate,
  type ResponseGateObserver
} from './realtime-response-gate'

type RealtimeEvent = Record<string, unknown>

function createHarness(now = 1000) {
  const sent: RealtimeEvent[] = []
  const outcomes: { outcome: string; queuedWaitMs: number | null }[] = []
  const observer: ResponseGateObserver = {
    recordCreateOutcome: (outcome, queuedWaitMs) => outcomes.push({ outcome, queuedWaitMs })
  }
  const gate = new RealtimeResponseGate(
    (event) => sent.push(event),
    observer,
    () => now
  )
  return { gate, sent, outcomes }
}

function create(): RealtimeEvent {
  return { type: 'response.create' }
}

function created(ref: string | null, id: string): RealtimeEvent {
  return {
    type: 'response.created',
    response: { id, ...(ref === null ? {} : { metadata: { ref } }) }
  }
}

function done(id: string): RealtimeEvent {
  return { type: 'response.done', response: { id } }
}

describe('tagResponseCreate', () => {
  it('stamps event_id and response.metadata.ref with the same unique ref', () => {
    const event = create()
    const ref = tagResponseCreate(event)
    expect(event.event_id).toBe(ref)
    expect(event.response).toMatchObject({ metadata: { ref } })
    const second = create()
    expect(tagResponseCreate(second)).not.toBe(ref)
  })
})

describe('RealtimeResponseGate', () => {
  it('passes non-create events through immediately', () => {
    const { gate, sent } = createHarness()
    expect(gate.sendEvent({ type: 'conversation.item.create', item: {} })).toBeNull()
    expect(sent).toHaveLength(1)
  })

  it('sends the first create immediately and queues while a response is active', () => {
    const { gate, sent } = createHarness()
    gate.sendEvent(create())
    gate.observe(created(null, 'resp_server'))
    expect(gate.sendEvent(create())?.outcome).toBe('queued')
    expect(sent).toHaveLength(1)
    gate.observe(done('resp_server'))
    expect(sent).toHaveLength(2)
  })

  it('does not treat a server-VAD response.created as the answer to our pending create', () => {
    const { gate, sent } = createHarness()
    gate.sendEvent(create())
    const ref = String(sent[0].event_id)
    // A foreign (server-VAD) response starts before our create is acknowledged.
    gate.observe(created(null, 'resp_foreign'))
    // An error that does not echo our ref is ignored.
    gate.observe({ type: 'error', event_id: 'unrelated', error: { message: 'other' } })
    // Our create's own created (echoing our ref) settles it.
    gate.observe(created(ref, 'resp_ours'))
    gate.observe(done('resp_foreign'))
    gate.observe(done('resp_ours'))
    expect(gate.queuedCount).toBe(0)
  })

  it('requeues a create rejected with conversation_already_has_active_response', () => {
    const { gate, sent, outcomes } = createHarness()
    gate.sendEvent(create())
    const ref = String(sent[0].event_id)
    gate.observe(created(null, 'resp_foreign'))
    gate.observe({
      type: 'error',
      event_id: ref,
      error: {
        message:
          'Conversation already has an active response: conversation_already_has_active_response'
      }
    })
    expect(outcomes.some((o) => o.outcome === 'requeued')).toBe(true)
    // Requeued at the head, but not re-sent while the foreign response is active.
    expect(sent).toHaveLength(1)
    gate.observe(done('resp_foreign'))
    expect(sent).toHaveLength(2)
    expect(sent[1].event_id).toBe(ref)
  })

  it('ignores an error echoing our ref but failing for another reason, then moves on', () => {
    const { gate, sent } = createHarness()
    gate.sendEvent(create())
    const ref = String(sent[0].event_id)
    gate.sendEvent(create())
    gate.observe({ type: 'error', event_id: ref, error: { message: 'rate limit' } })
    // The failed create is gone (reported), and the queued one stays queued until the
    // provider reports the response ended — nothing is re-sent blindly.
    expect(sent).toHaveLength(1)
    gate.observe(done('resp_foreign'))
    expect(sent).toHaveLength(2)
  })

  it('stops retrying after repeated active-response rejections until the next done', () => {
    const { gate, sent } = createHarness()
    gate.sendEvent(create())
    gate.observe(created(null, 'resp_foreign'))
    const ref = String(sent[0].event_id)
    const rejection = {
      type: 'error',
      event_id: ref,
      error: { message: 'conversation_already_has_active_response' }
    }
    gate.observe(rejection)
    gate.observe(rejection)
    gate.observe(rejection)
    const sentAfterRejections = sent.length
    gate.observe(rejection)
    expect(sent.length).toBe(sentAfterRejections)
    gate.observe(done('resp_foreign'))
    expect(sent.length).toBe(sentAfterRejections + 1)
  })

  it('ignores an unrelated error with a foreign event id, leaving the pending create alone', () => {
    const { gate, sent } = createHarness()
    gate.sendEvent(create())
    const firstRef = String(sent[0].event_id)
    gate.observe(created(firstRef, 'resp_a'))
    gate.observe(done('resp_a'))
    gate.sendEvent(create())
    gate.observe({
      type: 'error',
      event_id: 'some-other-ref',
      error: { code: 'rate_limit_exceeded', message: 'slow down' }
    })
    expect(gate.queuedCount).toBe(1)
  })

  // Live failure this guards: on gpt-realtime-2.1, rejection errors carry a server-side
  // event_* id, not our client ref — the second relay's create was rejected mid-barge-in
  // and dropped silently because the ref never matched.
  it('matches an active-response rejection by code when the error carries a server event id', () => {
    const { gate, sent, outcomes } = createHarness()
    gate.sendEvent(create())
    const ref = String(sent[0].event_id)
    gate.observe(created(null, 'resp_vad'))
    gate.observe({
      type: 'error',
      event_id: 'event_serverAssigned123',
      error: {
        code: 'conversation_already_has_active_response',
        message:
          'Conversation already has an active response in progress: resp_vad. Wait until the response is finished before creating a new one.'
      }
    })
    expect(outcomes.some((o) => o.outcome === 'requeued')).toBe(true)
    // Held while the VAD response is active, re-sent when it finishes.
    expect(sent).toHaveLength(1)
    gate.observe(done('resp_vad'))
    expect(sent).toHaveLength(2)
    expect(sent[1].event_id).toBe(ref)
  })

  it('reports queue wait time through the observer', () => {
    const { gate, outcomes } = createHarness(5000)
    gate.observe(created(null, 'resp_busy'))
    gate.sendEvent(create())
    gate.observe(done('resp_busy'))
    const flushed = outcomes.find((o) => o.outcome === 'sent' && o.queuedWaitMs !== null)
    expect(flushed?.queuedWaitMs).toBe(0)
  })
})

describe('RealtimeResponseGate stall recovery', () => {
  type ScheduledCallback = { cb: () => void; ms: number; cancelled: boolean }

  function createStallHarness(stallMs = 20_000) {
    const sent: RealtimeEvent[] = []
    const outcomes: { outcome: string; queuedWaitMs: number | null }[] = []
    const stalls: { ref: string; attempt: number; dropped: boolean }[] = []
    const scheduled: ScheduledCallback[] = []
    const observer: ResponseGateObserver = {
      recordCreateOutcome: (outcome, queuedWaitMs) => outcomes.push({ outcome, queuedWaitMs }),
      recordStallRecovery: (ref, attempt, dropped) => stalls.push({ ref, attempt, dropped })
    }
    const gate = new RealtimeResponseGate(
      (event) => sent.push(event),
      observer,
      () => 1000,
      {
        stallMs,
        scheduler: {
          setTimeout: (cb, ms) => {
            const entry: ScheduledCallback = { cb, ms, cancelled: false }
            scheduled.push(entry)
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate only stores the handle and hands it back to clearTimeout.
            return entry as unknown as ReturnType<typeof setTimeout>
          },
          clearTimeout: (handle) => {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handles this scheduler hands out are always ScheduledCallbacks.
            ;(handle as unknown as ScheduledCallback).cancelled = true
          }
        }
      }
    )
    const fireStall = () => {
      const entry = scheduled.find((candidate) => !candidate.cancelled)
      if (!entry) {
        throw new Error('no armed stall timer')
      }
      entry.cancelled = true
      entry.cb()
    }
    return { gate, sent, outcomes, stalls, scheduled, fireStall }
  }

  it('re-sends a pending create that saw no response lifecycle progress', () => {
    const { gate, sent, stalls, fireStall } = createStallHarness()
    gate.sendEvent(create())
    const ref = String(sent[0].event_id)
    expect(sent).toHaveLength(1)
    // The wire answer never comes — the stall budget elapses.
    fireStall()
    expect(sent).toHaveLength(2)
    expect(sent[1].event_id).toBe(ref)
    expect(stalls).toEqual([{ ref, attempt: 1, dropped: false }])
  })

  it('drops a create that stays unanswered past the recovery cap, then moves the queue on', () => {
    const { gate, sent, stalls, outcomes, fireStall } = createStallHarness()
    gate.sendEvent(create())
    const firstRef = String(sent[0].event_id)
    gate.observe(created(firstRef, 'resp_a'))
    gate.observe(done('resp_a'))
    gate.sendEvent(create())
    gate.sendEvent(create())
    const stalledRef = String(sent[1].event_id)
    fireStall()
    fireStall()
    fireStall()
    // Third strike: the wedged create is dropped and reported failed; the queued one sends.
    expect(stalls.at(-1)).toEqual({ ref: stalledRef, attempt: 3, dropped: true })
    expect(outcomes.some((o) => o.outcome === 'failed')).toBe(true)
    expect(sent.at(-1)?.event_id).not.toBe(stalledRef)
    expect(gate.queuedCount).toBe(1)
  })

  it('does not fire while queued behind a genuinely active response', () => {
    const { gate, sent, stalls, fireStall } = createStallHarness()
    gate.observe(created(null, 'resp_talking'))
    gate.sendEvent(create())
    expect(sent).toHaveLength(0)
    fireStall()
    // A long answer is not a stall: nothing is re-sent, nothing is cleared.
    expect(sent).toHaveLength(0)
    expect(stalls).toHaveLength(0)
    gate.observe(done('resp_talking'))
    expect(sent).toHaveLength(1)
  })

  it('disarms once nothing is outstanding', () => {
    const { gate, sent, scheduled } = createStallHarness()
    gate.sendEvent(create())
    const ref = String(sent[0].event_id)
    gate.observe(created(ref, 'resp_a'))
    gate.observe(done('resp_a'))
    expect(gate.queuedCount).toBe(0)
    expect(scheduled.every((entry) => entry.cancelled)).toBe(true)
  })

  it('stops arming after dispose', () => {
    const { gate, scheduled } = createStallHarness()
    gate.sendEvent(create())
    gate.dispose()
    expect(scheduled.every((entry) => entry.cancelled)).toBe(true)
  })
})
