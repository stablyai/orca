import sdkExit from '../fixtures/startup-sdk-process-exit.json'
import { afterEach, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { claudeStartupAnswerObservation } from '../claude-startup-answer-observation'
import { runClaudeControl } from '../claude-agent-sdk-control-requests'
import { retryableStructuredAgentSessionStart } from '../../native-chat/agent-session-wire/structured-agent-session-start-retry'
import { withObservedProviderExit } from '../../native-chat/agent-session-wire/structured-agent-session-failure-text'
import {
  adapterAtPublishFor,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'

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
