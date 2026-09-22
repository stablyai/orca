import { describe, expect, it } from 'vitest'
import { readBridgeHostMessage } from '../../mobile-web-shell/bridge/bridge-envelope'
import type { Recording, RecordingScenario } from '../rpc-recording/recording-scenario'
import type { BridgeRpcClientDiagnostic } from '../../mobile-web-shell/bridge/bridge-rpc-client'
import {
  divergingFields,
  paramsMismatchEvidence,
  refusalReleasedStream,
  refusedFrames,
  scriptsAbsentResultReply,
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
})

describe('reading what the page did about a frame it refused', () => {
  const refused: BridgeRpcClientDiagnostic = { kind: 'refused', refusal: 'unrecognised-message' }
  const failed: BridgeRpcClientDiagnostic = { kind: 'stream-failed', error: new Error('gone') }
  const ended: BridgeRpcClientDiagnostic = { kind: 'stream-ended', reason: 'closed' }

  it('sees a refusal the page answered by letting a stream go', () => {
    expect(refusalReleasedStream([ended, refused, failed, ended])).toBe(true)
  })

  it('sees nothing in a release the shell asked for, which reports the same kind', () => {
    expect(refusalReleasedStream([failed, ended])).toBe(false)
    expect(refusalReleasedStream([refused, ended, failed])).toBe(false)
    expect(refusalReleasedStream([refused])).toBe(false)
  })
})

describe('reading the throw the scripted transport raised', () => {
  const scripted = scenario([
    { complete: 'linear.listIssues#1', params: { filter: 'assigned', workspaceId: undefined } }
  ])
  const mismatch = new Error('Request params mismatch: linear.listIssues#1')
  const posted = (params: unknown): string[] => [
    JSON.stringify({ v: 1, type: 'ready' }),
    JSON.stringify({
      v: 1,
      type: 'request',
      id: 'aaaaaaaaaaaaaaaaaaaaaa',
      method: 'linear.listIssues',
      params
    })
  ]

  it('names the key the bridge dropped and the one the scenario valued `undefined`', () => {
    expect(paramsMismatchEvidence(mismatch, scripted, posted({ filter: 'assigned' }))).toEqual({
      step: 'linear.listIssues#1',
      undefinedValuedKeys: ['.workspaceId'],
      differingKeys: ['.workspaceId']
    })
  })

  it('names a key that arrived and was never scripted, which is what a wire bug looks like', () => {
    expect(
      paramsMismatchEvidence(mismatch, scripted, posted({ filter: 'assigned', seeded: 1 }))
    ).toEqual({
      step: 'linear.listIssues#1',
      undefinedValuedKeys: ['.workspaceId'],
      differingKeys: ['.seeded', '.workspaceId']
    })
  })

  it('reads a key nested under one the scenario scripts', () => {
    const nested = scenario([
      { complete: 'gitlab.updateMR#1', params: { iid: 7, updates: { body: undefined } } }
    ])
    expect(
      paramsMismatchEvidence(new Error('Request params mismatch: gitlab.updateMR#1'), nested, [
        JSON.stringify({
          v: 1,
          type: 'request',
          id: 'aaaaaaaaaaaaaaaaaaaaaa',
          method: 'gitlab.updateMR',
          params: { iid: 7, updates: {} }
        })
      ])
    ).toEqual({
      step: 'gitlab.updateMR#1',
      undefinedValuedKeys: ['.updates.body'],
      differingKeys: ['.updates.body']
    })
  })

  it("is nothing for a throw that is not the transport refusing a request's params", () => {
    expect(
      paramsMismatchEvidence(
        new Error('Missing subscription payload: a#1'),
        scripted,
        posted({ filter: 'assigned' })
      )
    ).toBeNull()
    expect(paramsMismatchEvidence('not an error at all', scripted, posted({}))).toBeNull()
  })

  it('is nothing when the scenario scripts no step by the name the throw printed', () => {
    expect(
      paramsMismatchEvidence(
        new Error('Request params mismatch: linear.listIssues#2'),
        scripted,
        posted({ filter: 'assigned' })
      )
    ).toBeNull()
  })

  it('is nothing when no frame for that step ever left the page', () => {
    expect(paramsMismatchEvidence(mismatch, scripted, [])).toBeNull()
  })
})
