import { describe, expect, it } from 'vitest'
import { answerAgentRequest } from './agent-request-answer'
import {
  nativeAnswerParams,
  parseAgentRequestAnswerFile,
  readAgentRequestAnswerFile
} from './agent-request-answer-file'
import {
  REQUEST_MARKER,
  REQUEST_PROMPT,
  REQUEST_RUNTIME,
  REQUEST_SESSION,
  REQUEST_SOURCE,
  REQUEST_WORKSPACE,
  answerFile,
  withAnswerBytes,
  requestFixtureClient
} from './agent-request-test-fixtures'
import { RuntimeRpcFailureError } from '../runtime/connection/types'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { AGENT_REQUEST_CLI_CAPABILITIES } from './agent-request-capabilities'
import { refuse } from '../../shared/agent-session/failures/agent-session-wire-refusals'
import { RUNTIME_SOURCE_FENCE_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/protocol/host-runtime-capabilities'

const scope = { worktree: `id:${REQUEST_WORKSPACE}`, sessionId: REQUEST_SESSION }
const ok = (result: unknown) => ({
  id: 'test',
  ok: true,
  _meta: { runtimeId: REQUEST_RUNTIME },
  result
})
const isMutation = (method: string) => method.startsWith('agentSession.respondTo')

describe('native answer JSON and admission', () => {
  it.each([false, true])(
    'preserves valid Unicode and typed text with leading BOM=%s',
    async (bom) => {
      const { optionId: _option, ...base } = answerFile()
      const answers = [
        { questionId: 'q1', optionIds: [], other: '한글 🙂\n둘째 줄 \uFFFD \uFEFF 그대로' }
      ]
      const input = { ...base, kind: 'question', answers }
      const bytes = Buffer.from((bom ? '\uFEFF' : '') + JSON.stringify(input), 'utf8')
      await withAnswerBytes(bytes, async (path) => {
        expect(await readAgentRequestAnswerFile(path)).toMatchObject(input)
      })
    }
  )

  it('rejects a second leading BOM rather than silently stripping it too', async () => {
    const bytes = Buffer.from(`\uFEFF\uFEFF${JSON.stringify(answerFile())}`, 'utf8')
    await withAnswerBytes(bytes, async (path) => {
      await expect(readAgentRequestAnswerFile(path)).rejects.toMatchObject({
        code: 'invalid_argument'
      })
    })
  })
  it('preserves exact grouped question ids, choices, newlines and UTF-8 answer text', () => {
    const input = answerFile()
    const { optionId: _option, ...base } = input
    const answers = [
      {
        questionId: '  원문 질문 / 1  ',
        optionIds: ['option:%20한글'],
        other: '첫 줄\n둘째 줄 "인용" C:\\경로\\파일'
      }
    ]
    const parsed = parseAgentRequestAnswerFile({ ...base, kind: 'question', answers })
    const params = nativeAnswerParams(parsed)
    expect('answers' in params && params.answers).toEqual(answers)
    const { envelope, ...fields } = params
    expect(envelope.payloadFingerprint).toBe(
      computeAgentSessionPayloadFingerprint({
        method: 'agentSession.respondTo:question',
        sessionId: REQUEST_SESSION,
        fields
      })
    )
  })

  it.each([
    { clientOperationId: 'not-a-uuid' },
    { kind: 'approve-all' },
    { expectedRuntimeFence: 0 },
    { expectedRevision: 0 },
    { extra: 'ignored?' },
    { expectedRequests: [] },
    { optionId: undefined },
    { answers: [] }
  ])('rejects malformed input without silently changing its meaning: %j', (change) => {
    expect(() => parseAgentRequestAnswerFile({ ...answerFile(), ...change })).toThrow()
  })

  it('sends one host-fenced exact answer and distinguishes acceptance from resumption', async () => {
    const { client, call } = requestFixtureClient()
    const input = parseAgentRequestAnswerFile(answerFile())
    const result = await answerAgentRequest(client, scope, input)
    expect(result.result).toMatchObject({
      outcome: 'accepted',
      resumed: 'unverified',
      clientOperationId: input.clientOperationId,
      result: { replayed: false }
    })
    const calls = call.mock.calls.filter(([method]) => isMutation(method))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[2]).toEqual({
      expectedRuntimeSource: { sourceId: REQUEST_SOURCE, runtimeId: REQUEST_RUNTIME }
    })
    expect(calls[0]?.[1]).toEqual(nativeAnswerParams(input))
  })

  it('delivers a grouped typed question answer and verifies its exact receipt', async () => {
    const answers = [
      { questionId: '  원문 질문 ID  ', optionIds: [], other: '  첫 줄\n둘째 줄 한글  ' }
    ]
    const question = {
      ...REQUEST_PROMPT,
      body: {
        kind: 'question',
        question: '원문 질문',
        options: [],
        questions: [
          {
            id: answers[0].questionId,
            question: '원문 질문',
            options: [],
            multiSelect: false,
            freeTextQuestionId: 'typed-answer',
            freeTextInput: { multiline: true }
          }
        ],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    }
    const { client, call } = requestFixtureClient((method, params) => {
      if (
        method === 'agentSession.currentRequests' &&
        typeof params === 'object' &&
        params !== null &&
        'version' in params &&
        params.version === REQUEST_MARKER.version
      ) {
        return ok({ marker: REQUEST_MARKER, json: JSON.stringify([question]), nextCursor: null })
      }
      if (method === 'agentSession.respondToQuestion') {
        return ok({
          ok: true,
          replayed: false,
          fence: 7,
          cursor: { epoch: REQUEST_MARKER.epoch, sequence: 2 },
          value: {
            itemId: REQUEST_PROMPT.itemId,
            revision: 2,
            resolution: {
              state: 'resolved',
              selectedOptionId: 'question-group:recorded',
              answers,
              resolvedBy: 'caller',
              resolvedAt: 100
            }
          }
        })
      }
      return undefined
    })
    const { optionId: _option, ...base } = answerFile()
    const input = parseAgentRequestAnswerFile({ ...base, kind: 'question', answers })
    const result = await answerAgentRequest(client, scope, input)
    expect(result.result.outcome).toBe('accepted')
    expect(result.result.result.value.resolution.answers).toEqual(answers)
    const mutation = call.mock.calls.filter(([method]) => isMutation(method))
    expect(mutation).toHaveLength(1)
    expect(mutation[0]?.[0]).toBe('agentSession.respondToQuestion')
    expect(mutation[0]?.[1]).toEqual(nativeAnswerParams(input))
  })

  it.each(['runtime', 'workspace', 'marker', 'fence', 'turn'])(
    'refuses changed %s before mutation',
    async (kind) => {
      const { client, call } = requestFixtureClient()
      const input = parseAgentRequestAnswerFile({
        ...answerFile(),
        ...(kind === 'runtime' ? { expectedRuntimeId: 'different-runtime' } : {}),
        ...(kind === 'workspace' ? { workspaceId: 'different::/workspace' } : {}),
        ...(kind === 'marker'
          ? { expectedRequests: { ...REQUEST_MARKER, owner: 'different-owner' } }
          : {}),
        ...(kind === 'fence' ? { expectedRuntimeFence: 99 } : {}),
        ...(kind === 'turn' ? { turnItemId: 'different-turn' } : {})
      })
      await expect(answerAgentRequest(client, scope, input)).rejects.toMatchObject({
        code: 'agent_request_unverifiable'
      })
      expect(call.mock.calls.filter(([method]) => isMutation(method))).toHaveLength(0)
    }
  )

  it('rechecks workspace identity after collecting the current requests', async () => {
    let reads = 0
    const { client, call } = requestFixtureClient((method) => {
      if (method !== 'session.tabs.list') {
        return
      }
      reads += 1
      return ok({
        worktree: reads === 1 ? REQUEST_WORKSPACE : 'other::/workspace',
        tabs: [{ type: 'agent-session', id: 'tab', sessionId: REQUEST_SESSION, agent: 'codex' }]
      })
    })
    await expect(
      answerAgentRequest(client, scope, parseAgentRequestAnswerFile(answerFile()))
    ).rejects.toMatchObject({ code: 'agent_request_unverifiable' })
    expect(call.mock.calls.filter(([method]) => isMutation(method))).toHaveLength(0)
  })

  it('requires host atomic-source-fence capability before sending', async () => {
    const { client, call } = requestFixtureClient((method) =>
      method === 'status.get'
        ? ok({
            runtimeId: REQUEST_RUNTIME,
            capabilities: AGENT_REQUEST_CLI_CAPABILITIES,
            hostDescriptor: { installationId: REQUEST_SOURCE }
          })
        : undefined
    )
    await expect(
      answerAgentRequest(client, scope, parseAgentRequestAnswerFile(answerFile()))
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(call.mock.calls.filter(([method]) => isMutation(method))).toHaveLength(0)
  })

  it('replays the same operation without requiring a still-pending prompt or current fence', async () => {
    const { client, call } = requestFixtureClient((method) => {
      if (method === 'agentSession.currentRequests') {
        throw new Error('must not select a new prompt')
      }
      if (isMutation(method)) {
        return ok({
          ok: true,
          replayed: true,
          fence: 88,
          cursor: { epoch: 'epoch-later', sequence: 100 },
          value: {
            itemId: answerFile().itemId,
            revision: 2,
            resolution: {
              state: 'resolved',
              selectedOptionId: 'approve',
              resolvedBy: 'caller',
              resolvedAt: 100
            }
          }
        })
      }
      return undefined
    })
    const input = parseAgentRequestAnswerFile({
      ...answerFile(),
      expectedRuntimeFence: 6,
      turnItemId: 'finished-turn'
    })
    const result = await answerAgentRequest(client, scope, input, input.clientOperationId)
    expect(result.result.result.replayed).toBe(true)
    expect(
      call.mock.calls.filter(([method]) => method === 'agentSession.currentRequests')
    ).toHaveLength(0)
    const mutations = call.mock.calls.filter(([method]) => isMutation(method))
    expect(mutations).toHaveLength(1)
    expect(mutations[0]?.[1]).toEqual({ ...nativeAnswerParams(input), replayOnly: true })
    expect(mutations[0]?.[2]).toEqual({
      expectedRuntimeSource: { sourceId: REQUEST_SOURCE, runtimeId: REQUEST_RUNTIME }
    })
    await expect(
      answerAgentRequest(client, scope, input, '44444444-4444-4444-8444-444444444444')
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('refuses retry on a host without receipt-only support before sending', async () => {
    const { client, call } = requestFixtureClient((method) =>
      method === 'status.get'
        ? ok({
            runtimeId: REQUEST_RUNTIME,
            capabilities: [
              ...AGENT_REQUEST_CLI_CAPABILITIES,
              RUNTIME_SOURCE_FENCE_RUNTIME_CAPABILITY
            ],
            hostDescriptor: { installationId: REQUEST_SOURCE }
          })
        : undefined
    )
    const input = parseAgentRequestAnswerFile(answerFile())
    await expect(
      answerAgentRequest(client, scope, input, input.clientOperationId)
    ).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(call.mock.calls.filter(([method]) => isMutation(method))).toHaveLength(0)
  })

  it('sends once after an exact receipt miss and successful current-request validation', async () => {
    const { client, call } = requestFixtureClient((method, params) => {
      if (
        isMutation(method) &&
        typeof params === 'object' &&
        params !== null &&
        'replayOnly' in params
      ) {
        return ok({
          ok: false,
          refusal: refuse(
            'agent_session_operation_invalid',
            { reason: 'receiptMissing' },
            'No recorded receipt.'
          )
        })
      }
      return undefined
    })
    const input = parseAgentRequestAnswerFile(answerFile())
    const result = await answerAgentRequest(client, scope, input, input.clientOperationId)
    expect(result.result.result.replayed).toBe(false)
    const mutations = call.mock.calls.filter(([method]) => isMutation(method))
    expect(mutations.map(([, params]) => params)).toEqual([
      { ...nativeAnswerParams(input), replayOnly: true },
      nativeAnswerParams(input)
    ])
    expect(mutations.map(([, , options]) => options)).toEqual([
      { expectedRuntimeSource: { sourceId: REQUEST_SOURCE, runtimeId: REQUEST_RUNTIME } },
      { expectedRuntimeSource: { sourceId: REQUEST_SOURCE, runtimeId: REQUEST_RUNTIME } }
    ])
    const methods = call.mock.calls.map(([method]) => method)
    expect(methods.indexOf('agentSession.currentRequests')).toBeGreaterThan(
      methods.indexOf('agentSession.respondToApproval')
    )
  })

  it.each(['pending', 'turn', 'fence', 'marker', 'option'])(
    'never executes a missing retry receipt with an invalid current %s',
    async (kind) => {
      const { client, call } = requestFixtureClient((method, params) => {
        if (isMutation(method)) {
          return ok({
            ok: false,
            refusal: refuse(
              'agent_session_operation_invalid',
              { reason: 'receiptMissing' },
              'No recorded receipt.'
            )
          })
        }
        if (
          kind === 'pending' &&
          method === 'agentSession.currentRequests' &&
          typeof params === 'object' &&
          params !== null &&
          'version' in params &&
          params.version === REQUEST_MARKER.version
        ) {
          return ok({ marker: REQUEST_MARKER, json: '[]', nextCursor: null })
        }
        return undefined
      })
      const input = parseAgentRequestAnswerFile({
        ...answerFile(),
        ...(kind === 'turn' ? { turnItemId: 'other-turn' } : {}),
        ...(kind === 'fence' ? { expectedRuntimeFence: 6 } : {}),
        ...(kind === 'marker' ? { expectedRequests: { ...REQUEST_MARKER, revision: 2 } } : {}),
        ...(kind === 'option' ? { optionId: 'unoffered' } : {})
      })
      await expect(
        answerAgentRequest(client, scope, input, input.clientOperationId)
      ).rejects.toMatchObject({
        code: kind === 'option' ? 'invalid_argument' : 'agent_request_unverifiable'
      })
      const mutations = call.mock.calls.filter(([method]) => isMutation(method))
      expect(mutations).toHaveLength(1)
      expect(mutations[0]?.[1]).toEqual({ ...nativeAnswerParams(input), replayOnly: true })
    }
  )

  it.each([
    'transport',
    'rpc-miss',
    'other-refusal',
    'malformed-miss',
    'malformed-success',
    'not-replayed'
  ])('does not send after an unproven receipt miss: %s', async (kind) => {
    const { client, call } = requestFixtureClient((method) => {
      if (!isMutation(method)) {
        return undefined
      }
      if (kind === 'transport') {
        throw new Error('response lost')
      }
      if (kind === 'rpc-miss') {
        throw new RuntimeRpcFailureError({
          id: 'test',
          ok: false,
          error: { code: 'agent_session_operation_invalid', message: 'receiptMissing' },
          _meta: { runtimeId: REQUEST_RUNTIME }
        })
      }
      if (kind === 'malformed-success') {
        return ok({ ok: true, replayed: true })
      }
      if (kind === 'not-replayed') {
        return undefined
      }
      return ok({
        ok: false,
        refusal: {
          code:
            kind === 'other-refusal'
              ? 'agent_session_operation_unknown'
              : 'agent_session_operation_invalid',
          details: { reason: 'receiptMissing', unexpected: true }
        }
      })
    })
    const input = parseAgentRequestAnswerFile(answerFile())
    await expect(
      answerAgentRequest(client, scope, input, input.clientOperationId)
    ).rejects.toMatchObject({
      code: ['rpc-miss', 'malformed-miss'].includes(kind)
        ? 'agent_session_operation_invalid'
        : 'agent_session_operation_unknown'
    })
    expect(call.mock.calls.filter(([method]) => isMutation(method))).toHaveLength(1)
    expect(
      call.mock.calls.filter(([method]) => method === 'agentSession.currentRequests')
    ).toHaveLength(0)
  })

  it('retains a definitive permission refusal instead of calling it a timeout', async () => {
    const { client } = requestFixtureClient((method) => {
      if (isMutation(method)) {
        throw new RuntimeRpcFailureError({
          id: 'refused',
          ok: false,
          error: { code: 'forbidden', message: 'Host permission denied' },
          _meta: { runtimeId: REQUEST_RUNTIME }
        })
      }
    })
    await expect(
      answerAgentRequest(client, scope, parseAgentRequestAnswerFile(answerFile()))
    ).rejects.toMatchObject({
      code: 'forbidden',
      data: { outcome: 'refused', resumed: 'unverified' }
    })
  })

  it('never automatically retries an uncertain transport result', async () => {
    const { client, call } = requestFixtureClient((method) => {
      if (isMutation(method)) {
        throw new Error('response lost after acceptance')
      }
    })
    await expect(
      answerAgentRequest(client, scope, parseAgentRequestAnswerFile(answerFile()))
    ).rejects.toMatchObject({
      code: 'agent_session_operation_unknown',
      data: {
        outcome: 'unknown',
        clientOperationId: answerFile().clientOperationId
      }
    })
    expect(call.mock.calls.filter(([method]) => isMutation(method))).toHaveLength(1)
  })

  it.each(['item', 'choice', 'revision', 'malformed', 'retry-item', 'retry-choice'])(
    'does not label a mismatched %s receipt accepted',
    async (kind) => {
      const { client } = requestFixtureClient((method) => {
        if (!isMutation(method)) {
          return
        }
        if (kind === 'malformed') {
          return ok({ ok: true })
        }
        return ok({
          ok: true,
          replayed: kind.startsWith('retry-'),
          fence: 7,
          cursor: { epoch: REQUEST_MARKER.epoch, sequence: 2 },
          value: {
            itemId: kind.endsWith('item') ? 'different-item' : answerFile().itemId,
            revision: kind === 'revision' ? 0 : 2,
            resolution: {
              state: 'resolved',
              selectedOptionId: kind.endsWith('choice') ? 'deny' : 'approve',
              resolvedBy: 'caller',
              resolvedAt: 100
            }
          }
        })
      })
      await expect(
        answerAgentRequest(
          client,
          scope,
          parseAgentRequestAnswerFile(answerFile()),
          kind.startsWith('retry-') ? answerFile().clientOperationId : undefined
        )
      ).rejects.toMatchObject({ code: 'agent_session_operation_unknown' })
    }
  )
})
