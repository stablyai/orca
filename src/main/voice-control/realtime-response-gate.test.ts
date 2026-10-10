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
