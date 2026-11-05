import canonicalFilenameRefusal from '../../codex/app-server/fixtures/start-resume-canonical-filename-refusal.json'
import sdkExit from '../../claude/fixtures/startup-sdk-process-exit.json'
import { CodexAppServerUnsupportedError } from '../../codex/app-server/codex-app-server-session'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  AcpAgentError,
  AcpAgentExitedError,
  AcpConnectionClosedError,
  AcpInvalidResponseError,
  AcpRequestTimeoutError,
  AcpRpcError
} from '../../acp/acp-errors'
import { acpRpcEnvelopeSchema, settleAcpResponse } from '../../acp/acp-rpc-envelope'
import {
  ClaudeControlRequestError,
  runClaudeControl
} from '../../claude/claude-agent-sdk-control-requests'
import { createCodexAppServerRecordDispatcher } from '../../codex/app-server/codex-app-server-record-dispatch'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { JsonlRpcPeer, JsonlRpcResponseError } from '../../jsonl-rpc/peer'
import { withProviderRequestTimeout } from '../../provider-process/provider-request-timeout'
import {
  withMissingProviderExecutable,
  withProviderSpawnAbsence
} from '../../provider-process/provider-executable-missing'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { CodexAppServerExitError } from '../../codex/app-server/codex-app-server-exit-error'
import { JsonlRpcAgentExitError } from '../../jsonl-rpc/agent-connection'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from './structured-agent-session-acquisition-errors'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter-errors'
import { withObservedProviderExit } from './structured-agent-session-failure-text'
import {
  agentSessionAcquireFailure,
  agentSessionStartFailure,
  retryableAgentSessionAcquisition,
  type AgentSessionStartAnswer,
  type AgentSessionStartFailure
} from './structured-agent-session-start-failure'
import { codexStartFailure, codexStartupAnswer } from '../../codex/app-server/codex-startup-outcome'
import { acpStartFailure, acpStartupAnswer } from '../../acp/acp-startup-outcome'
import { piStartFailure, piStartupAnswer } from '../../pi/rpc-startup-outcome'
import { claudeStartFailure, claudeStartupAnswer } from '../../claude/claude-startup-failure'
import captures from './__fixtures__/startup-protocol-rejections.json'

// Each adapter reads only its own answers; the shared rule then gives the generic verdict.
const adapterAnswer: AgentSessionStartAnswer = (cause) =>
  [codexStartupAnswer, acpStartupAnswer, piStartupAnswer, claudeStartupAnswer]
    .map((answer) => answer(cause))
    .find((verdict) => verdict !== undefined)

function retryableStructuredAgentSessionStart(error: unknown): boolean {
  return agentSessionStartFailure(error, adapterAnswer).retry === 'safe'
}

function retryableStructuredAgentSessionAcquisition(error: unknown): boolean {
  return retryableAgentSessionAcquisition(agentSessionAcquireFailure(error, adapterAnswer))
}

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

function expectFinalWithExitEvidence(error: unknown) {
  expect(retryableStructuredAgentSessionStart(error)).toBe(false)
  expect(
    retryableStructuredAgentSessionAcquisition(new AgentSessionAcquisitionExitProvenError(error))
  ).toBe(false)
  if (!(error instanceof Error)) {
    throw new Error('expected Error')
  }
  expect(retryableStructuredAgentSessionStart(withObservedProviderExit(error))).toBe(false)
}

describe('recorded command rejection wrappers at the startup classifier', () => {
  it('keeps a recorded Claude control rejection final, including after exit', async () => {
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
    expectFinalWithExitEvidence(error)
  })

  it('keeps a recorded Codex answer final outside resume too', async () => {
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
    expectFinalWithExitEvidence(error)
  })

  it('keeps a recorded Pi rejection final, including after exit', async () => {
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
      expectFinalWithExitEvidence(error)
    } finally {
      peer.close()
      input.destroy()
      output.destroy()
    }
  })

  it('keeps a recorded ACP permanent rejection final', async () => {
    const capture = captures.acp
    const pending = Promise.withResolvers<unknown>()
    const failed = pending.promise.catch((caught: unknown) => caught)
    const diagnose = vi.fn()
    settleAcpResponse(acpRpcEnvelopeSchema.parse(capture.response), pending, diagnose)
    const error = await failed
    expect(error).toBeInstanceOf(AcpAgentError)
    expect(error).toMatchObject(capture.response.error)
    expect(diagnose).not.toHaveBeenCalled()
    expectFinalWithExitEvidence(error)
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

  it.each([-32600, -32603])('keeps unknown Codex resume answers final: %s', (code) => {
    expectFinalWithExitEvidence(
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

// The wire capture has no error.data, so the error is built without one.
it('keeps the recorded canonical rollout filename refusal final on the first answer', () => {
  const { method, code, message } = canonicalFilenameRefusal
  expectFinalWithExitEvidence(new CodexAppServerRequestError(method, code, message, message))
})

it('preserves an actual SDK nonzero exit through initialize control cleanup', async () => {
  const recorded = sdkExit.records[0].initializationError
  if (!recorded) {
    throw new Error('missing recorded initialization error')
  }
  const cause = Object.assign(new Error(recorded.message), recorded)
  const error = await runClaudeControl('initialize', () => Promise.reject(cause)).catch(
    (error) => error
  )
  expect(error.cause).toBe(cause)
  expectExitEvidenceRequired(error)
})

it('keeps unsupported Codex methods final after process exit too', () => {
  expectFinalWithExitEvidence(new CodexAppServerUnsupportedError('method unsupported'))
})

describe('positive provider startup retry contracts', () => {
  const codex = (method: string, code: number, message: string, data?: unknown) =>
    new CodexAppServerRequestError(method, code, message, message, data)
  it.each([
    codex('initialize', -32001, 'Server overloaded; retry later.'),
    codex('thread/start', -32600, 'Server is draining; retry after reconnecting', {
      reason: 'serverShuttingDown'
    }),
    codex('thread/resume', -32600, 'Server is draining; retry after reconnecting', {
      reason: 'serverShuttingDown'
    }),
    codex('thread/start', -32600, 'Workspace change in progress; retry when it completes'),
    codex(
      'thread/resume',
      -32600,
      'thread abc is closing; retry thread/resume after the thread is closed'
    ),
    ...['thread/start', 'thread/resume'].flatMap((method) => [
      codex(method, -32600, 'failed to load configuration', {
        reason: 'cloudConfigBundle',
        errorCode: 'Timeout'
      }),
      ...[undefined, 503, 403].map((statusCode) =>
        codex(method, -32600, 'failed to load configuration', {
          reason: 'cloudConfigBundle',
          errorCode: 'RequestFailed',
          statusCode,
          detail: 'Failed to load cloud config bundle (workspace-managed policies).'
        })
      )
    ]),
    codex(
      'thread/start',
      -32603,
      'error creating thread: storage failed: thread-store retryable error: busy'
    ),
    new AcpAgentError(-32603, 'server unavailable', { errorName: 'ServerUnavailable' }),
    new AcpAgentError(-32603, 'catalog not ready', { errorName: 'CatalogNotReady' })
  ])('retries only after separately proving absence: $message', expectExitEvidenceRequired)

  it.each([
    ...['thread/start', 'thread/resume'].flatMap((method) => [
      ...['Auth', 'InvalidBundle', 'Internal', 'RequestFailed'].map((errorCode) =>
        codex(method, -32600, 'failed to load configuration', {
          reason: 'cloudConfigBundle',
          errorCode
        })
      ),
      codex(method, -32600, 'failed to load configuration', {
        reason: 'cloudConfigBundle',
        errorCode: 'Timeout',
        action: 'relogin'
      })
    ]),
    codex('thread/start', -32603, 'error creating thread: outcome unknown'),
    codex('thread/start', -32603, 'error creating thread: internal error'),
    codex('thread/resume', -32600, 'please retry this unknown answer')
  ])(
    'does not infer retry from an error code or a generic message: $message',
    expectFinalWithExitEvidence
  )

  it.each([
    ['control_request_failed', false],
    ['process_exited_nonzero', true],
    ['process_killed_by_signal', true],
    ['error_result', false],
    ['initialize_timeout', false],
    ['executable_not_found', false],
    ['executable_launch_failed', false],
    ['aborted', false],
    ['unreadable', false],
    ['future_unknown_tag', false],
    [undefined, false]
  ])('preserves SDK %s through the control wrapper', async (errorClass, retry) => {
    const cause = Object.assign(new Error('SDK error'), errorClass ? { errorClass } : {})
    const error = await runClaudeControl('initialize', () => Promise.reject(cause)).catch(
      (error) => error
    )
    expect(error.cause).toBe(cause)
    expect(retryableStructuredAgentSessionStart(error)).toBe(retry)
    if (!retry) {
      expectFinalWithExitEvidence(error)
    }
  })

  it('preserves Codex error.data at the response boundary', async () => {
    const pending = Promise.withResolvers<unknown>()
    const result = pending.promise.catch((error) => error)
    const dispatcher = createCodexAppServerRecordDispatcher({
      handlers: {},
      writeResponse: vi.fn(),
      onProtocolFailure: vi.fn()
    })
    dispatcher.addPending(1, { method: 'thread/start', ...pending, timer: undefined })
    const data = { reason: 'serverShuttingDown' }
    dispatcher.dispatch({
      id: 1,
      error: { code: -32600, message: 'Server is draining; retry after reconnecting', data }
    })
    const error = await result
    if (!(error instanceof CodexAppServerRequestError)) {
      throw new Error('expected a Codex request error')
    }
    expect(error.data).toBe(data)
    expect(Object.keys(error)).not.toContain('data')
    expectExitEvidenceRequired(error)
  })
})

describe('one verdict from every observation of a failed start', () => {
  const recordedSdkExit = async (exitCode: number) => {
    const recorded = sdkExit.records[0].initializationError
    if (!recorded) {
      throw new Error('missing recorded initialization error')
    }
    // The Debian lane's supervised spawn ENOENT: the recorded SDK shape, with the supervisor's 127.
    const cause = Object.assign(new Error(`Claude Code process exited with code ${exitCode}`), {
      ...recorded,
      exitCode
    })
    return runClaudeControl('initialize', () => Promise.reject(cause)).catch(
      (error: unknown) => error
    )
  }
  const claudeOwnExit = (message: string) => withObservedProviderExit(new Error(message))
  const recordedCodexRefusal = async () => {
    const pending = Promise.withResolvers<unknown>()
    const failed = pending.promise.catch((caught: unknown) => caught)
    const dispatcher = createCodexAppServerRecordDispatcher({
      handlers: {},
      writeResponse: vi.fn(),
      onProtocolFailure: vi.fn()
    })
    dispatcher.addPending(captures.codex.request.id, {
      method: captures.codex.request.method,
      ...pending,
      timer: undefined
    })
    dispatcher.dispatch(captures.codex.response)
    return failed
  }
  const loadTimeout = new AcpRequestTimeoutError('session/load', 300_000)
  type Row = {
    name: string
    verdict: (evidence: unknown[]) => AgentSessionStartFailure
    observations: () => Promise<[explains: unknown, other: unknown]>
    retry: 'safe' | 'never'
    kind: string
  }
  const rows: Row[] = [
    {
      name: "Claude: Orca's exit that found no CLI over the SDK's exit 127 report",
      verdict: (evidence) => claudeStartFailure(evidence),
      observations: async () => [
        withMissingProviderExecutable(
          claudeOwnExit('claude stream-json exited (code 127): spawn claude ENOENT')
        ),
        await recordedSdkExit(127)
      ],
      retry: 'never',
      kind: 'cliMissing'
    },
    {
      name: "Claude: Orca's plain exit record over the SDK's report of it",
      verdict: (evidence) => claudeStartFailure(evidence),
      observations: async () => [
        claudeOwnExit('claude stream-json exited (code 1)'),
        await recordedSdkExit(1)
      ],
      retry: 'safe',
      kind: 'providerStartFailed'
    },
    {
      name: 'Claude: a recorded control rejection over its exit',
      verdict: (evidence) => claudeStartFailure(evidence),
      observations: async () => [
        await runClaudeControl(captures.claude.request.request.subtype, () =>
          Promise.reject(new Error(captures.claude.response.response.error))
        ).catch((caught: unknown) => caught),
        claudeOwnExit('claude stream-json exited (code 1)')
      ],
      retry: 'never',
      kind: 'startFailed'
    },
    {
      name: 'Codex: a recorded refusal over its drained exit, worded as that exit',
      verdict: (evidence) => codexStartFailure(evidence, true),
      observations: async () => [
        await recordedCodexRefusal(),
        new CodexAppServerExitError('codex app-server exited')
      ],
      retry: 'never',
      kind: 'providerStartFailed'
    },
    {
      name: 'Codex: a declared temporary answer beside its drained exit',
      verdict: (evidence) => codexStartFailure(evidence, true),
      observations: async () => [
        new CodexAppServerRequestError('initialize', -32001, 'Server overloaded; retry later.'),
        new CodexAppServerExitError('codex app-server exited')
      ],
      retry: 'safe',
      kind: 'providerStartFailed'
    },
    {
      name: 'ACP: a load deadline over the exit seen while its output drained',
      verdict: (evidence) => acpStartFailure(evidence, true),
      observations: async () => [loadTimeout, new AcpAgentExitedError('agent exited')],
      retry: 'never',
      kind: 'startFailed'
    },
    {
      name: "ACP: a deleted launch folder over the transport's closed summary",
      verdict: (evidence) => acpStartFailure(evidence),
      observations: async () => [
        withProviderSpawnAbsence(new AcpAgentExitedError('agent exited'), 'launchFolder'),
        new AcpConnectionClosedError()
      ],
      retry: 'never',
      kind: 'launchFolderMissing'
    },
    {
      name: 'Pi: a recorded rejection over its exit',
      verdict: (evidence) => piStartFailure(evidence),
      observations: async () => [
        new JsonlRpcResponseError(captures.pi.response.command, captures.pi.response.error),
        new JsonlRpcAgentExitError('Pi exited while starting')
      ],
      retry: 'never',
      kind: 'startFailed'
    },
    {
      name: 'Pi: its exit explains an unexplained failure, which still keeps the start final',
      verdict: (evidence) => piStartFailure(evidence),
      observations: async () => [
        new JsonlRpcAgentExitError('Pi exited while starting'),
        new Error('Invalid agent RPC response')
      ],
      retry: 'never',
      kind: 'providerStartFailed'
    }
  ]

  it.each(rows)('$name', async ({ verdict, observations, retry, kind }) => {
    const [explains, other] = await observations()
    // Precedence is the policy's, not the order the adapter saw them in.
    for (const evidence of [
      [explains, other],
      [other, explains]
    ]) {
      const failure = verdict(evidence)
      expect(failure.cause).toBe(explains)
      expect(failure.retry).toBe(retry)
      expect(failure.fact.kind).toBe(kind)
    }
  })

  it("keeps a deadline's method, duration and words over the exit around it", () => {
    const failure = acpStartFailure([new AcpAgentExitedError('agent exited'), loadTimeout], true)
    const timedOut = agentSessionFailureFact('startFailed', {
      requestTimeout: { method: 'session/load', timeoutMs: 300_000 }
    })
    expect(failure.fact).toEqual(timedOut)
    expect(agentSessionFailureWords(failure.fact, { surface: 'rejection' })).toEqual(
      agentSessionFailureWords(timedOut, { surface: 'rejection' })
    )
  })

  it('still lets an unanswered exit run again when every observation is that exit', async () => {
    const own = claudeOwnExit('claude stream-json exited (code 1)')
    expect(claudeStartFailure([own, await recordedSdkExit(1)]).retry).toBe('safe')
    expect(piStartFailure([new JsonlRpcAgentExitError('Pi exited while starting')]).retry).toBe(
      'safe'
    )
  })
})
