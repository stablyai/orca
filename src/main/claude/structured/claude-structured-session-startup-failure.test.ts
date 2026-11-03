import sdkExit from '../fixtures/startup-sdk-process-exit.json'
import { afterEach, expect, it, vi } from 'vitest'
import { findInErrorChain } from '../../provider-process/provider-error-chain'
import { withMissingProviderExecutable } from '../../provider-process/provider-executable-missing'
import { claudeStartupAnswerObservation } from '../claude-startup-answer-observation'
import { runClaudeControl } from '../claude-agent-sdk-control-requests'
import { withObservedProviderExit } from '../../native-chat/agent-session-wire/structured-agent-session-failure-text'
import {
  PROVIDER_SESSION_ID,
  adapterAtPublishFor,
  adapterFor,
  fakeClaude,
  identityFor,
  recordingJournalSink,
  tick
} from './claude-structured-session-test-support'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import { NDJSON_MAX_LINE_BYTES } from '../../../shared/main-process-ndjson-framer'
import { claudeAcquireFailure, claudeStartFailure } from '../claude-startup-failure'
import { retryableAgentSessionAcquisition } from '../../native-chat/agent-session-wire/structured-agent-session-start-failure'

const retryableStructuredAgentSessionStart = (error: unknown): boolean =>
  claudeStartFailure(error).retry === 'safe'
const retryableStructuredAgentSessionAcquisition = (error: unknown): boolean =>
  retryableAgentSessionAcquisition(claudeAcquireFailure(error))

afterEach(() => vi.useRealTimers())

it.each(['control_request_failed', 'process_exited_nonzero'])(
  'preserves the independently pending SDK %s outcome when exit proof wins first',
  async (errorClass) => {
    vi.useFakeTimers()
    const claude = fakeClaude({ holdInit: true })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterAtPublishFor(claude, {}, events)
    const acquired = await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'race'
    })
    const connection = claude.connections[0]
    const pending = Promise.withResolvers<unknown>()
    connection.initializationResult = () =>
      runClaudeControl('initialize', () => pending.promise, null)
    // Delay SDK cleanup, independently of the actual process exit.
    connection.close = () => new Promise(() => {})
    const result = adapter
      .open({
        sessionId: 'session-1',
        fence: 7,
        acquisitionGeneration: acquired.acquisitionGeneration,
        signal: new AbortController().signal
      })
      .catch((error) => error)
    connection.closed = true
    connection.exitVerdict = { root: 'exited', tree: 'exited' }
    const exit = withObservedProviderExit(new Error('claude exited'))
    connection.handlers.onExit?.(exit, { expected: false })
    await vi.advanceTimersByTimeAsync(10)
    const recorded = sdkExit.records[0].initializationError
    if (!recorded) {
      throw new Error('missing recorded SDK exit')
    }
    pending.reject(
      errorClass === 'process_exited_nonzero'
        ? Object.assign(new Error(recorded.message), recorded)
        : Object.assign(new Error('SDK terminal outcome'), { errorClass, exitCode: 1 })
    )
    await vi.advanceTimersByTimeAsync(2_000)
    const error = await result
    // The SDK's report of the exit is no answer, so Orca's own exit record decides the start.
    if (errorClass === 'process_exited_nonzero') {
      expect(error.cause).toBe(exit)
    } else {
      expect(error.cause.cause).toMatchObject({ errorClass, exitCode: 1 })
    }
    expect(retryableStructuredAgentSessionStart(error)).toBe(
      errorClass === 'process_exited_nonzero'
    )
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    claude.dispose()
    await adapter.closeAll()
  }
)

it('retains a failed result before a stalled SDK transcript flush and never waits on startup cursor persistence', async () => {
  vi.useFakeTimers()
  const claude = fakeClaude({ holdInit: true })
  const persist = vi.fn(() => new Promise<void>(() => {}))
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = adapterAtPublishFor(claude, {}, events, [], undefined, persist)
  const acquired = await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'flush' })
  const connection = claude.connections[0]
  connection.close = () => new Promise(() => {})
  const observation = claudeStartupAnswerObservation()
  connection.startupFailure = observation.failure
  const result = adapter
    .open({
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: acquired.acquisitionGeneration,
      signal: new AbortController().signal
    })
    .catch((error) => error)
  observation.feed(
    `${JSON.stringify({
      type: 'result',
      is_error: true,
      subtype: 'error_during_execution',
      errors: ['startup refused']
    })}\n`
  )
  connection.closed = true
  connection.exitVerdict = { root: 'exited', tree: 'exited' }
  connection.handlers.onExit?.(withObservedProviderExit(new Error('exited')), { expected: false })
  await vi.advanceTimersByTimeAsync(2_100)
  const error = await result
  expect(error.cause.errorClass).toBe('error_result')
  expect(retryableStructuredAgentSessionStart(error)).toBe(false)
  expect(persist).not.toHaveBeenCalled()
  expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
  claude.dispose()
  await adapter.closeAll()
})

it('treats a turn that settled without an Orca dispatch as past startup on exit', async () => {
  const claude = fakeClaude()
  const persistedHandles: unknown[] = []
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = adapterFor(claude, {}, events, persistedHandles)
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'undispatched',
    events: { ...recordingJournalSink(), written: async () => ({ ok: true }) }
  })
  const connection = claude.connections[0]
  // No send ran, so the startup observer still holds a later failed result.
  connection.startupFailure = () =>
    Object.assign(new Error('claude reported a failed result during startup'), {
      errorClass: 'error_result'
    })
  const frame = (message: Record<string, unknown>) =>
    connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
  frame({
    type: 'assistant',
    uuid: 'undispatched-leaf',
    message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
  })
  frame({ type: 'result' })
  connection.handlers.onExit?.(withObservedProviderExit(new Error('exited')), { expected: false })
  await tick()

  expect(persistedHandles).toContainEqual(
    expect.objectContaining({ leafUuid: 'undispatched-leaf' })
  )
  expect(events.at(-1)).toMatchObject({ type: 'ended', failure: { kind: 'providerExited' } })
  claude.dispose()
  await adapter.closeAll()
})

it("reads a missing CLI from Orca's exit when the SDK reports the exit first", async () => {
  const claude = fakeClaude({ holdInit: true })
  const adapter = adapterAtPublishFor(claude)
  const acquired = await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'missing-cli'
  })
  const connection = claude.connections[0]
  const exited = Promise.withResolvers<Error>()
  connection.exited = exited.promise
  // A supervised spawn ENOENT: the supervisor exits 127 and the SDK reports only that exit.
  connection.initializationResult = () =>
    runClaudeControl(
      'initialize',
      () =>
        Promise.reject(
          Object.assign(new Error('Claude Code process exited with code 127'), {
            errorClass: 'process_exited_nonzero',
            exitCode: 127
          })
        ),
      null
    )
  const result = adapter
    .open({
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: acquired.acquisitionGeneration,
      signal: new AbortController().signal
    })
    .catch((error) => error)
  await tick()
  exited.resolve(
    withMissingProviderExecutable(
      withObservedProviderExit(
        new Error('claude stream-json exited (code 127): spawn claude ENOENT')
      )
    )
  )
  const error = await result
  expect(error).toMatchObject({ retry: 'never', fact: { kind: 'cliMissing' } })
  claude.dispose()
  await adapter.closeAll()
})

it('settles an unanswered Claude startup exit with the same bounded recovery eligibility', async () => {
  vi.useFakeTimers()
  const claude = fakeClaude({ holdInit: true })
  const adapter = adapterAtPublishFor(claude)
  const acquired = await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'no-answer'
  })
  const connection = claude.connections[0]
  connection.close = () => new Promise(() => {})
  const result = adapter
    .open({
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: acquired.acquisitionGeneration,
      signal: new AbortController().signal
    })
    .catch((error) => error)
  const error = withObservedProviderExit(new Error('child exited before initialize'))
  connection.closed = true
  connection.exitVerdict = { root: 'exited', tree: 'exited' }
  connection.handlers.onExit?.(error, { expected: false })
  await vi.advanceTimersByTimeAsync(2_100)
  expect((await result).cause).toBe(error)
  expect(retryableStructuredAgentSessionStart(await result)).toBe(true)
  claude.dispose()
  await adapter.closeAll()
})

it('keeps a rejected initialize final when the child exits before acquisition publishes', async () => {
  const claude = fakeClaude({ holdInit: true })
  const probing = Promise.withResolvers<void>()
  const startTime = Promise.withResolvers<number>()
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      cliFlag: async () => 'supported' as const,
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => {
      probing.resolve()
      return startTime.promise
    }
  })
  const result = adapter
    .acquire({ identity: identityFor(), fence: 7, spawnToken: 'prepublication' })
    .catch((error) => error)
  await probing.promise
  const connection = claude.connections[0]
  // The SDK's answer to an error control_response for initialize, as the published path sees it.
  const answer = runClaudeControl(
    'initialize',
    () =>
      Promise.reject(
        Object.assign(new Error('initialize rejected'), { errorClass: 'control_request_failed' })
      ),
    null
  )
  connection.initializationResult = () => answer
  connection.closed = true
  connection.exitVerdict = { root: 'exited', tree: 'unverifiable' }
  connection.close = async () => false
  connection.handlers.onExit?.(withObservedProviderExit(new Error('claude exited (code 1)')), {
    expected: false
  })
  startTime.resolve(1_700_000_000_000)
  const error = await result
  expect(
    findInErrorChain(error, (cause) => ('errorClass' in cause ? cause.errorClass : undefined))
  ).toBe('control_request_failed')
  expect(retryableStructuredAgentSessionAcquisition(error)).toBe(false)
  claude.dispose()
  connection.close = async () => true
  await adapter.closeAll()
})

it('parses only failed root results at startup, bounded by candidates rather than records', async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const hook = (output: string) =>
    `${JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'SessionStart:startup',
      hook_event: 'SessionStart',
      output,
      stdout: '',
      stderr: ''
    })}\n`
  const assistant = (text: string) =>
    `${JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text }] }
    })}\n`
  const failedResult = (subtype: string) =>
    `${JSON.stringify({ type: 'result', subtype, is_error: true })}\n`
  // Counts the real observer's work for one child at a given startup record population.
  const observeStartup = async (records: number) => {
    const observation = claudeStartupAnswerObservation()
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const oversized = hook('x'.repeat(NDJSON_MAX_LINE_BYTES + 1))
      observation.feed(oversized.slice(0, NDJSON_MAX_LINE_BYTES / 2))
      observation.feed(oversized.slice(NDJSON_MAX_LINE_BYTES / 2))
      for (let index = 0; index < records; index += 1) {
        observation.feed(
          index % 2 === 0
            ? hook(JSON.stringify({ type: 'result', is_error: true, index }))
            : assistant(`working ${index}`)
        )
      }
      // Later failed results coalesced into the capturing chunk must not be parsed.
      observation.feed(
        failedResult('error_during_execution') +
          failedResult('error_in_capturing_chunk').repeat(records)
      )
      await flush()
      const parsed = parse.mock.calls.map(([text]) => String(text))
      const failure = observation.failure()
      parse.mockClear()
      observation.feed(failedResult('error_after_capture'))
      observation.feed(hook('after capture'))
      observation.finish()
      observation.feed(failedResult('error_after_finish'))
      await flush()
      return {
        irrelevantParses: parsed.filter(
          (text) => !text.includes('error_during_execution') && !text.includes('capturing_chunk')
        ).length,
        candidateParses: parsed.filter((text) => text.includes('error_during_execution')).length,
        sameChunkParsesAfterCapture: parsed.filter((text) => text.includes('capturing_chunk'))
          .length,
        failure,
        parsesAfterCapture: parse.mock.calls.length
      }
    } finally {
      parse.mockRestore()
    }
  }
  const n = await observeStartup(100)
  const tenN = await observeStartup(1000)
  expect(n).toMatchObject({
    irrelevantParses: 0,
    candidateParses: 1,
    sameChunkParsesAfterCapture: 0,
    failure: expect.objectContaining({ errorClass: 'error_result' }),
    parsesAfterCapture: 0
  })
  expect(tenN).toEqual(n)
})

it('takes no startup answer from a line over the budget', async () => {
  const observation = claudeStartupAnswerObservation()
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const large = 'x'.repeat(NDJSON_MAX_LINE_BYTES + 1)
  // Tool input is arbitrary JSON; a result-shaped object inside it is not the provider's answer.
  const assistant = `${JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Write',
          input: { type: 'result', is_error: true, content: large }
        }
      ]
    }
  })}\n`
  observation.feed(assistant.slice(0, NDJSON_MAX_LINE_BYTES))
  observation.feed(assistant.slice(NDJSON_MAX_LINE_BYTES))
  await flush()
  expect(observation.failure()).toBeUndefined()
  // The parent that marks a subagent result can sit past the retained prefix.
  observation.feed(
    `${JSON.stringify({ type: 'result', is_error: true, errors: [large], parent_tool_use_id: 'task-1' })}\n`
  )
  // Intended limit: an oversized failed root result is left to the SDK answer or the unanswered exit.
  observation.feed(`${JSON.stringify({ type: 'result', is_error: true, errors: [large] })}\n`)
  await flush()
  expect(observation.failure()).toBeUndefined()
  observation.feed(
    `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true })}\n`
  )
  await flush()
  expect(observation.failure()).toMatchObject({ errorClass: 'error_result' })
  const parse = vi.spyOn(JSON, 'parse')
  try {
    observation.feed(`${JSON.stringify({ type: 'result', subtype: 'later', is_error: true })}\n`)
    expect(parse).not.toHaveBeenCalled()
  } finally {
    parse.mockRestore()
  }
})
