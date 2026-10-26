import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AcpAgentError } from '../../acp/acp-errors'
import { acpRpcEnvelopeSchema, settleAcpResponse } from '../../acp/acp-rpc-envelope'
import {
  ClaudeControlRequestError,
  runClaudeControl
} from '../../claude/claude-agent-sdk-control-requests'
import { createCodexAppServerRecordDispatcher } from '../../codex/codex-app-server-record-dispatch'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { JsonlRpcPeer, JsonlRpcResponseError } from '../../jsonl-rpc/peer'
import { withProviderRequestTimeout } from '../../provider-process/provider-request-timeout'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from './structured-agent-session-acquisition-errors'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter-errors'
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

describe('recorded command rejection wrappers at the startup classifier', () => {
  it('wraps Claude rejection text at the SDK callback boundary', async () => {
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

  it('dispatches the recorded Codex reply with its method, code and provider diagnostic', async () => {
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

  it('parses the recorded Pi rejection through the JSONL peer', async () => {
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

  it('parses the recorded ACP agent error without losing code or data', async () => {
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
})
