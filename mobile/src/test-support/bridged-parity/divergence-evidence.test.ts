import { absentResultExplainsResiduals } from './absent-result-evidence'
import { describe, expect, it } from 'vitest'
import { readBridgeHostMessage } from '../../mobile-web-shell/bridge/bridge-envelope'
import type { Recording, RecordingScenario } from '../rpc-recording/recording-scenario'
import type { BridgeRpcClientDiagnostic } from '../../mobile-web-shell/bridge/bridge-rpc-client'
import { recordingDifferences, valueDifferences } from '../rpc-recording/golden-difference'
import { classifyBridgedParity } from './divergence-classes'
import { strictReplayVerdict } from './replay-verdict'
import {
  createBridgePortPair,
  type BridgePortPair
} from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import type { RpcClient } from '../../transport/rpc-client'
import { ScriptedRpcTransport } from '../rpc-recording/scripted-rpc-transport'
import { agentHistoryHostStatusRead } from '../../agent-history/mobile-agent-history-operations'
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
  family: 'f',
  sites: [],
  schedules: [],
  steps
})

function classify(
  expected: Recording,
  actual: Recording,
  scenarios: RecordingScenario[] = [],
  pairs: Parameters<typeof absentResultExplainsResiduals>[3] = []
) {
  const explained = absentResultExplainsResiduals(expected, actual, scenarios, pairs)
  return classifyBridgedParity({
    fixedByReplyMeta: false,
    threwWhileRecording: false,
    divergingFields: divergingFields(expected, actual),
    absentResultExplainsResiduals: explained,
    paramsMismatch: null,
    refusalReleasedStream: false
  })
}

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
    // The current reader accepts replies without meta; retain the counterfactual lane to detect a future narrowing regression.
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
      withoutRpcMeta([
        {
          _meta: { runtimeId: 'outer' },
          value: {
            ok: true,
            _meta: { runtimeId: 'inner' },
            result: [1, null, { _meta: { runtimeId: 'nested' }, _metaish: 'keep' }]
          }
        }
      ])
    ).toEqual([{ value: { ok: true, result: [1, null, { _metaish: 'keep' }] } }])
  })
})

describe('the fields that diverged', () => {
  it('requires independent original and reply-meta evidence at the replay admission seam', () => {
    const expected = recording({
      sender: [{ ordinal: 1 }],
      payloads: [{ json: '{"id":"frame-1","method":"status.get"}' }]
    })
    const ordinal = structuredClone(expected)
    ordinal.checkpoints[0]!.observation.sender = [{ ordinal: 2 }]
    const run = (value: Recording | null, thrown: unknown = null) => ({
      recording: value,
      thrown,
      pairs: []
    })
    expect(strictReplayVerdict(expected, [], run(ordinal), run(ordinal)).name).toBe('write-ordinal')
    for (const original of [
      run(null, new Error('Original failed')),
      run(expected, new Error('Late failure'))
    ]) {
      const result = strictReplayVerdict(expected, [], original, run(ordinal))
      expect(result.original.name).toBe('unclassified')
      expect(result.replyMeta.name).toBe('write-ordinal')
      expect(result.name).toBe('unclassified')
    }
    for (const change of [
      { state: { corrupted: true } },
      { payloads: [{ json: '{"id":"frame-2","method":"status.get"}' }] }
    ]) {
      const corrupt = structuredClone(ordinal)
      Object.assign(corrupt.checkpoints[0]!.observation, change)
      const result = strictReplayVerdict(expected, [], run(corrupt), run(ordinal))
      expect(result.original.name).toBe('unclassified')
      expect(result.replyMeta.name).toBe('write-ordinal')
      expect(result.name).toBe('unclassified')
      expect(strictReplayVerdict(expected, [], run(ordinal), run(corrupt)).name).toBe(
        'unclassified'
      )
    }
    const meta = structuredClone(ordinal)
    meta.checkpoints[0]!.observation.settlements = {
      _meta: { runtimeId: 'counterfactual-runtime' }
    }
    expect(strictReplayVerdict(expected, [], run(ordinal), run(meta)).name).toBe('write-ordinal')
    meta.checkpoints[0]!.observation.settlements = { _meta: { runtimeId: 'unexpected-runtime' } }
    expect(strictReplayVerdict(expected, [], run(ordinal), run(meta)).name).toBe('unclassified')
  })

  it('keeps later wire differences and occurrence-aligned shared checkpoints despite list changes', () => {
    const expected = recording({
      sender: [{ ordinal: 1, settlement: { value: { id: 'frame-2' } } }],
      payloads: [{ ordinal: 1, json: 'subscribe' }, { json: 'frame-2' }]
    })
    const actual = recording({
      sender: [{ ordinal: 2, settlement: { value: { id: 'frame-1' } } }],
      payloads: [{ ordinal: 2, json: 'worktree' }, { json: 'frame-1' }]
    })
    expect(divergingFields(expected, actual)[0]).toBe('sender[0].ordinal')
    expect(classify(expected, actual)).toBe('unclassified')
    expected.checkpoints.push(...structuredClone(expected.checkpoints))
    actual.checkpoints.unshift({ ...structuredClone(actual.checkpoints[0]!), id: 'extra' })
    actual.checkpoints.push(...structuredClone(actual.checkpoints.slice(1)))
    expect(
      recordingDifferences(expected, actual, true).map(
        ({ checkpoint, field, path }) => `${checkpoint}:${field}${path}`
      )
    ).toEqual(
      ['only', 'only#2'].flatMap((key) =>
        [
          'sender[0].ordinal',
          'sender[0].settlement.value.id',
          'payloads[0].json',
          'payloads[0].ordinal',
          'payloads[1].json'
        ].map((path) => `${key}:${path}`)
      )
    )
    const fields = divergingFields(expected, actual)
    expect(fields[0]).toBe('checkpoints')
    expect(classify(expected, actual)).toBe('unclassified')
    expect(
      valueDifferences({ a: null, b: { $rpc: 'undefined' }, c: [1, 2], d: {} }, { c: [3], d: [] })
    ).toMatchObject([
      { path: '.a', expected: null, expectedPresent: true, actualPresent: false },
      { path: '.b', expected: { $rpc: 'undefined' }, actualPresent: false },
      { path: '.c.length', expected: 2, actual: 1 },
      { path: '.c[0]', expected: 1, actual: 3 },
      { path: '.c[1]', expectedPresent: true, actualPresent: false },
      { path: '.d', expected: {}, actual: [] }
    ])
    expect(divergingFields(recording({ state: Array(1) }), recording({ state: [] }))).toEqual([
      'state.length'
    ])
  })

  it('attributes a real malformed exchange without excusing valid wire changes beside it', async () => {
    const pairs: BridgePortPair<RpcClient>[] = []
    const native = new ScriptedRpcTransport()
    const makeBridge = (rewriteToPage?: (json: string) => string) =>
      new ScriptedRpcTransport(
        () => 0,
        undefined,
        (rpc) => {
          const pair = createBridgePortPair({ rpc, rewriteToPage })
          pairs.push(pair)
          for (let round = 0; round < 4; round += 1) {
            pair.drainNow()
          }
          return pair.client
        }
      )
    const bridge = makeBridge()
    const metaBridge = makeBridge(withReplyMeta)
    const pair = pairs[0]!
    const metaPair = pairs[1]!
    try {
      const nativeReply = native.client.sendRequest('status.get', {})
      const nativeWorktrees = native.client.sendRequest('worktree.ps', { limit: 10000 })
      const bridgeReply = bridge.client
        .sendRequest('status.get', {})
        .catch((error: unknown) => error)
      const bridgeWorktrees = bridge.client
        .sendRequest('worktree.ps', { limit: 10000 })
        .catch((error: unknown) => error)
      const metaReply = metaBridge.client
        .sendRequest('status.get', {})
        .catch((error: unknown) => error)
      const metaWorktrees = metaBridge.client
        .sendRequest('worktree.ps', { limit: 10000 })
        .catch((error: unknown) => error)
      await Promise.all(pairs.map((entry) => entry.flush()))
      native.complete('status.get#1', {}, { ok: true })
      bridge.complete('status.get#1', {}, { ok: true })
      metaBridge.complete('status.get#1', {}, { ok: true })
      const worktreeParams = { limit: 10000, supportsWorktreeVisibilitySourceDefaults: true }
      native.complete('worktree.ps#1', worktreeParams, { ok: true })
      bridge.complete('worktree.ps#1', worktreeParams, { ok: true })
      metaBridge.complete('worktree.ps#1', worktreeParams, { ok: true })
      await Promise.all([nativeWorktrees, bridgeWorktrees, metaWorktrees])
      const [reply, error, metaError] = await Promise.all([nativeReply, bridgeReply, metaReply])
      await Promise.all(pairs.map((entry) => entry.flush()))
      const message = 'The host sent a reply this app could not read (status.get)'
      expect(() => agentHistoryHostStatusRead.interpret(reply)).toThrow(message)
      if (!(error instanceof Error) || !(metaError instanceof Error)) {
        throw new Error('missing actual bridge refusal')
      }
      const snapshot = (transport: ScriptedRpcTransport, text: string) =>
        recording({
          sender: structuredClone(transport.requests),
          payloads: structuredClone(transport.payloads),
          state: { screenState: { kind: 'error', message: text } }
        })
      const expected = snapshot(native, message)
      const actual = snapshot(bridge, error.message)
      const injected = {
        ...scenario([
          { complete: 'status.get#1', params: {}, reply: { ok: true } },
          { complete: 'worktree.ps#1', params: worktreeParams, reply: { ok: true } },
          { checkpoint: 'only' }
        ]),
        operation: 'aiVault.history-scan'
      }
      const original = { recording: actual, thrown: null, pairs: [pair] }
      const replyMeta = {
        recording: snapshot(metaBridge, metaError.message),
        thrown: null,
        pairs: [metaPair]
      }
      expect(strictReplayVerdict(expected, [injected], original, replyMeta).name).toBe(
        'result-absent-settlement'
      )
      expect(
        strictReplayVerdict(expected, [injected], { ...original, pairs: [] }, replyMeta).name
      ).toBe('unclassified')
      expect(
        strictReplayVerdict(expected, [injected], original, { ...replyMeta, pairs: [] }).name
      ).toBe('unclassified')
      expect(classify(expected, actual, [injected], [pair])).toBe('result-absent-settlement')
      const changed = structuredClone(actual)
      changed.checkpoints[0]!.observation.payloads = [
        { name: 'status.get#1', ordinal: 2, json: '{"id":"frame-1","method":"wrong"}' }
      ]
      expect(classify(expected, changed, [injected], [pair])).toBe('unclassified')
      expect(
        strictReplayVerdict(expected, [injected], { ...original, recording: changed }, replyMeta)
          .name
      ).toBe('unclassified')
      const sibling = scenario([{ checkpoint: 'only' }])
      sibling.id = 'normal'
      const combined = (injection: Recording, normal: Recording): Recording => ({
        scenario: 'matrix',
        checkpoints: [
          { ...normal.checkpoints[0]!, id: 'normal:only' },
          { ...injection.checkpoints[0]!, id: 's:only' }
        ]
      })
      expect(
        classify(
          combined(expected, expected),
          combined(actual, changed),
          [sibling, injected],
          [pair, pair]
        )
      ).toBe('unclassified')
      expect(
        classify(
          expected,
          actual,
          [{ ...injected, steps: [{ checkpoint: 'only' }, injected.steps[0]!] }],
          [pair]
        )
      ).toBe('unclassified')
    } finally {
      for (const entry of pairs) {
        entry.client.close()
        entry.host.dispose()
      }
      native.dispose()
      bridge.dispose()
      metaBridge.dispose()
    }
  })
  it('reports every one, not the first', () => {
    const expected = recording({ sender: [{ ordinal: 1 }], effects: [{ name: 'a' }] })
    const actual = recording({ sender: [{ ordinal: 2 }], effects: [{ name: 'b' }] })
    expect(divergingFields(expected, actual)).toEqual(['sender[0].ordinal', 'effects[0].name'])
  })

  it('names the checkpoint list when the two runs did not reach the same ones', () => {
    const expected = recording({})
    const actual: Recording = { scenario: 's', checkpoints: [] }
    expect(divergingFields(expected, actual)).toEqual(['checkpoints'])
    expect(
      divergingFields(expected, {
        scenario: 's',
        checkpoints: expected.checkpoints.map((checkpoint) => ({ ...checkpoint, id: 'renamed' }))
      })
    ).toEqual(['checkpoints'])
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
