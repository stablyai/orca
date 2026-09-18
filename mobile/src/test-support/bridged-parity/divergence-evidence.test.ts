import { describe, expect, it } from 'vitest'
import { readBridgeHostMessage } from '../../mobile-web-shell/bridge/bridge-envelope'
import type { Recording, RecordingScenario } from '../rpc-recording/recording-scenario'
import {
  divergingFields,
  refusedFrames,
  scriptsAbsentResultReply,
  sendsUndefinedValuedParam,
  withoutRpcMeta,
  withReplyMeta
} from './divergence-evidence'

const scenario = (steps: RecordingScenario['steps']): RecordingScenario => ({
  id: 's',
  operation: 'o',
  version: 1,
  family: 'f',
  sites: [],
  schedules: [],
  steps
})

const recording = (
  observation: Partial<Recording['checkpoints'][number]['observation']>
): Recording => ({
  scenario: 's',
  checkpoints: [
    {
      id: 'only',
      observation: {
        sender: [],
        payloads: [],
        settlements: {},
        state: null,
        effects: [],
        ...observation
      }
    }
  ]
})

describe('reading the refused frames back', () => {
  const id = 'aaaaaaaaaaaaaaaaaaaaaa'

  it('keeps only what the page would drop', () => {
    const dropped = JSON.stringify({ v: 1, type: 'reply', id, payload: { id: 'f', ok: true } })
    const kept = JSON.stringify({ v: 1, type: 'end', id, reason: 'closed' })
    expect(refusedFrames([dropped, kept])).toEqual([dropped])
  })

  it('changes no verdict on a reply, now that the field is not what the page reads for', () => {
    // The class this counterfactual was built to measure is closed: the page's reader is
    // `isRpcResponse`, which asks for no `_meta` on either arm. The lane stays because it is what
    // tells a future narrowing apart from a payload that genuinely moved, and a run where it
    // changes a verdict is that narrowing coming back.
    const reply = JSON.stringify({
      v: 1,
      type: 'reply',
      id,
      payload: { id: 'f', ok: true, result: 1 }
    })
    expect(readBridgeHostMessage(reply).ok).toBe(true)
    expect(readBridgeHostMessage(withReplyMeta(reply)).ok).toBe(true)
  })

  it('leaves a payload the page refuses for its own shape refused', () => {
    const absent = JSON.stringify({ v: 1, type: 'reply', id, payload: { id: 'f', ok: true } })
    expect(readBridgeHostMessage(withReplyMeta(absent)).ok).toBe(false)
  })

  it('leaves anything that is not a reply alone', () => {
    const end = JSON.stringify({ v: 1, type: 'end', id, reason: 'closed' })
    expect(withReplyMeta(end)).toBe(end)
  })

  it('adds the field a reply payload is missing', () => {
    const reply = JSON.stringify({ v: 1, type: 'reply', id, payload: { id: 'f', ok: true } })
    expect(JSON.parse(withReplyMeta(reply)).payload._meta).toEqual({
      runtimeId: 'counterfactual-runtime'
    })
  })

  it('leaves an event payload alone, which carries a `payload` of its own', () => {
    const event = JSON.stringify({ v: 1, type: 'event', id, seq: 0, payload: { chunk: 'a' } })
    expect(withReplyMeta(event)).toBe(event)
  })
})

describe('undoing the counterfactual', () => {
  it('removes every `_meta`, however deep, and nothing else', () => {
    expect(
      withoutRpcMeta([{ value: { ok: true, _meta: { runtimeId: 'r' }, result: [1] } }])
    ).toEqual([{ value: { ok: true, result: [1] } }])
  })
})

describe('the fields that diverged', () => {
  it('reports every one, not the first', () => {
    const expected = recording({ sender: [{ ordinal: 1 }], effects: [{ name: 'a' }] })
    const actual = recording({ sender: [{ ordinal: 2 }], effects: [{ name: 'b' }] })
    expect(divergingFields(expected, actual)).toEqual(['sender[0].ordinal', 'effects[0].name'])
  })

  it('names the checkpoint list when the two runs did not reach the same ones', () => {
    const expected = recording({})
    const actual: Recording = { scenario: 's', checkpoints: [] }
    expect(divergingFields(expected, actual)).toEqual(['checkpoints'])
  })

  it('is empty when the two agree', () => {
    expect(divergingFields(recording({}), recording({}))).toEqual([])
  })
})

describe('reading the scenario', () => {
  it('sees a reply that is `ok` with no `result` key', () => {
    expect(
      scriptsAbsentResultReply(scenario([{ complete: 'a#1', params: null, reply: { ok: true } }]))
    ).toBe(true)
    expect(
      scriptsAbsentResultReply(
        scenario([{ complete: 'a#1', params: null, reply: { ok: true, result: null } }])
      )
    ).toBe(false)
  })

  it('sees an own param key whose value is `undefined`, however deep', () => {
    expect(
      sendsUndefinedValuedParam(scenario([{ complete: 'a#1', params: { q: undefined } }]))
    ).toBe(true)
    expect(
      sendsUndefinedValuedParam(scenario([{ complete: 'a#1', params: { q: [{ r: undefined }] } }]))
    ).toBe(true)
    expect(sendsUndefinedValuedParam(scenario([{ complete: 'a#1', params: { q: null } }]))).toBe(
      false
    )
  })
})
