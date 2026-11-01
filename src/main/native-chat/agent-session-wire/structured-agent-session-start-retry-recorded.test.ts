import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AcpAgentError, AcpInvalidResponseError, AcpRpcError } from '../../acp/acp-errors'
import { acpRpcEnvelopeSchema, settleAcpResponse } from '../../acp/acp-rpc-envelope'
import {
  ClaudeControlRequestError,
  runClaudeControl
} from '../../claude/claude-agent-sdk-control-requests'
import { createCodexAppServerRecordDispatcher } from '../../codex/codex-app-server-record-dispatch'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { JsonlRpcPeer, JsonlRpcResponseError } from '../../jsonl-rpc/peer'
import { withProviderRequestTimeout } from '../../provider-process/provider-request-timeout'
import { withProviderSpawnAbsence } from '../../provider-process/provider-executable-missing'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from './structured-agent-session-acquisition-errors'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter-errors'
import { withObservedProviderExit } from './structured-agent-session-failure-text'
import {
  retryableStructuredAgentSessionAcquisition,
  retryableStructuredAgentSessionStart
} from './structured-agent-session-start-retry'
import captures from './__fixtures__/startup-protocol-rejections.json'

function expectExitEvidenceRequired(error: unknown) {
  expect(retryableStructuredAgentSessionStart(error)).toBe(true)
  expect(retryableStructuredAgentSessionAcquisition(error)).toBe(false)
  expect(
    retryableStructuredAgentSessionAcquisition(new AgentSessionAcquisitionExitProvenError(error))
  ).toBe(true)
  expect(
    retryableStructuredAgentSessionAcquisition(
      new AgentSessionAcquisitionRootExitObservedError(error)
    )
  ).toBe(true)
  expect(
    retryableStructuredAgentSessionAcquisition(new AgentSessionAcquisitionExitUnprovenError(error))
  ).toBe(false)
}

function expectFinalWithExitEvidence(error: Error) {
  expect(retryableStructuredAgentSessionStart(error)).toBe(false)
  expect(
    retryableStructuredAgentSessionAcquisition(new AgentSessionAcquisitionExitProvenError(error))
  ).toBe(false)
  expect(retryableStructuredAgentSessionStart(withObservedProviderExit(error))).toBe(false)
}

describe('recorded command rejection wrappers at the startup classifier', () => {
  it('keeps recorded Claude permission rejection retryable without a typed startup refusal', async () => {
    const capture = captures.claude
    // SDK rejection is supplied here; this does not exercise the SDK's wire parser.
    const error = await runClaudeControl(capture.request.request.subtype, () =>
      Promise.reject(new Error(capture.response.response.error))
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClaudeControlRequestError)
    expect(error).toMatchObject({
      subtype: capture.request.request.subtype,
      message: capture.response.response.error
    })
    expectExitEvidenceRequired(error)
  })

  it('keeps the recorded Codex invalid thread/read answer retryable outside resume', async () => {
    const capture = captures.codex
    const pending = Promise.withResolvers<unknown>()
    const failed = pending.promise.catch((caught: unknown) => caught)
    const dispatcher = createCodexAppServerRecordDispatcher({
      handlers: {},
      writeResponse: vi.fn(),
      onProtocolFailure: vi.fn()
    })
    dispatcher.addPending(capture.request.id, {
      method: capture.request.method,
      ...pending,
      timer: undefined
    })
    dispatcher.dispatch(capture.response)
    const error = await failed
    expect(error).toBeInstanceOf(CodexAppServerRequestError)
    expect(error).toMatchObject({
      method: capture.request.method,
      code: capture.response.error.code,
      providerDiagnostic: { text: capture.response.error.message, audience: 'person' }
    })
    expectExitEvidenceRequired(error)
  })

  it('keeps the recorded Pi model rejection retryable without a typed startup refusal', async () => {
    const capture = captures.pi
    const input = new PassThrough()
    const output = new PassThrough()
    const peer = new JsonlRpcPeer(input, output)
    try {
      const failed = peer
        .request(capture.request.type, {
          provider: capture.request.provider,
          modelId: capture.request.modelId
        })
        .catch((caught: unknown) => caught)
      // Only correlation changes: the peer allocates orca-1 instead of the capture harness id.
      input.write(`${JSON.stringify({ ...capture.response, id: 'orca-1' })}\n`)
      const error = await failed
      expect(error).toBeInstanceOf(JsonlRpcResponseError)
      expect(error).toMatchObject({
        command: capture.response.command,
        message: capture.response.error
      })
      expectExitEvidenceRequired(error)
    } finally {
      peer.close()
      input.destroy()
      output.destroy()
    }
  })

  it('keeps the recorded ACP -32603 retryable regardless of its InvalidRequestError data', async () => {
    const capture = captures.acp
    const pending = Promise.withResolvers<unknown>()
    const failed = pending.promise.catch((caught: unknown) => caught)
    const diagnose = vi.fn()
    settleAcpResponse(acpRpcEnvelopeSchema.parse(capture.response), pending, diagnose)
    const error = await failed
    expect(error).toBeInstanceOf(AcpAgentError)
    expect(error).toMatchObject(capture.response.error)
    expect(diagnose).not.toHaveBeenCalled()
    expectExitEvidenceRequired(error)
  })

  it.each([
    new AcpInvalidResponseError('Invalid ACP response envelope', {}),
    new AcpRpcError(-32601, 'ACP agent cannot load or resume this session')
  ])('keeps Orca-made ACP errors final even with exit evidence: $message', (error) => {
    expectFinalWithExitEvidence(error)
  })

  it.each([
    'invalid session id: invalid character',
    captures.codex.response.error.message,
    'thread not found: missing-thread',
    'no rollout found for thread id missing-thread'
  ])('ends Codex -32600 resume identity failures even with exit evidence: %s', async (message) => {
    const pending = Promise.withResolvers<unknown>()
    const failed = pending.promise.catch((caught: unknown) => caught)
    const dispatcher = createCodexAppServerRecordDispatcher({
      handlers: {},
      writeResponse: vi.fn(),
      onProtocolFailure: vi.fn()
    })
    dispatcher.addPending(1, { method: 'thread/resume', ...pending, timer: undefined })
    dispatcher.dispatch({ id: 1, error: { code: -32600, message } })
    const error = await failed
    expect(error).toBeInstanceOf(CodexAppServerRequestError)
    if (!(error instanceof CodexAppServerRequestError)) {
      throw new Error('Expected the dispatched Codex request error')
    }
    expectFinalWithExitEvidence(error)
  })

  it.each([
    new AcpAgentError(-32601, 'Method not found'),
    new AcpAgentError(-32602, 'Invalid params'),
    new CodexAppServerRequestError('initialize', -32602, 'Invalid params')
  ])('keeps standard method and parameter rejections final: $name $code', (error) => {
    expectFinalWithExitEvidence(error)
  })

  it.each([-32600, -32603])('keeps unknown Codex resume answers retryable: %s', (code) => {
    expectExitEvidenceRequired(
      new CodexAppServerRequestError('thread/resume', code, 'Server is temporarily unavailable')
    )
  })

  it.each([
    ['typed refusal', new AgentSessionAcquisitionRefusal('sign in', 'notSignedIn')],
    [
      'local request deadline',
      withProviderRequestTimeout(new Error('deadline'), { method: 'initialize', timeoutMs: 250 })
    ],
    ['host fault', new Error('journal write failed')]
  ])('keeps %s final even with exit proof (local policy control)', (_name, error) => {
    expect(retryableStructuredAgentSessionStart(error)).toBe(false)
    expect(
      retryableStructuredAgentSessionAcquisition(new AgentSessionAcquisitionExitProvenError(error))
    ).toBe(false)
  })

  it('keeps a working folder deleted under the chat final, even with its exit observed', () => {
    expectFinalWithExitEvidence(
      withProviderSpawnAbsence(new Error('claude exited (code 127)'), 'launchFolder')
    )
  })
})
