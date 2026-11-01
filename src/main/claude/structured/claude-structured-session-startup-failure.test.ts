import sdkExit from '../fixtures/startup-sdk-process-exit.json'
import { afterEach, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { claudeStartupAnswerObservation } from '../claude-startup-answer-observation'
import { runClaudeControl } from '../claude-agent-sdk-control-requests'
import { retryableStructuredAgentSessionStart } from '../../native-chat/agent-session-wire/structured-agent-session-start-retry'
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
import { retryableStructuredAgentSessionAcquisition } from '../../native-chat/agent-session-wire/structured-agent-session-start-retry'
import { NDJSON_MAX_LINE_BYTES } from '../../../shared/main-process-ndjson-framer'

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
    expect(error.cause).toMatchObject({ errorClass, exitCode: 1 })
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
  const raw = createFakePipedChild()
  const observation = claudeStartupAnswerObservation()
  observation.attach(raw)
  connection.startupFailure = observation.failure
  const result = adapter
    .open({
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: acquired.acquisitionGeneration,
      signal: new AbortController().signal
    })
    .catch((error) => error)
  raw.stdout.write(
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
  expect(error.errorClass).toBe('error_result')
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
  expect(await result).toBe(error)
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
  expect(error.cause.cause).toMatchObject({ errorClass: 'control_request_failed' })
  expect(retryableStructuredAgentSessionAcquisition(error)).toBe(false)
  claude.dispose()
  connection.close = async () => true
  await adapter.closeAll()
})

it('parses only a failed root result at startup and bounds what it retains', async () => {
  const child = createFakePipedChild()
  const observation = claudeStartupAnswerObservation()
  observation.attach(child)
  const parse = vi.spyOn(JSON, 'parse')
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
  const oversized = hook('x'.repeat(NDJSON_MAX_LINE_BYTES + 1))
  child.stdout.write(oversized.slice(0, NDJSON_MAX_LINE_BYTES / 2))
  child.stdout.write(oversized.slice(NDJSON_MAX_LINE_BYTES / 2))
  child.stdout.write(hook(JSON.stringify({ type: 'result', is_error: true })))
  child.stdout.write(
    `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true })}\n`
  )
  await new Promise((resolve) => setImmediate(resolve))
  const parsed = parse.mock.calls.map(([text]) => String(text))
  parse.mockRestore()
  expect(parsed.filter((text) => text.includes('hook_response'))).toEqual([])
  expect(parsed.filter((text) => text.includes('error_during_execution'))).toHaveLength(1)
  expect(observation.failure()).toMatchObject({ errorClass: 'error_result' })
  expect(child.stdout.listenerCount('data')).toBe(0)
})
