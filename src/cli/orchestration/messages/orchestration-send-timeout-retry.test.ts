import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimeClientError } from '../../runtime/connection/types'
import type { RuntimeClient } from '../../runtime/client'

const { printOrchestrationResultMock } = vi.hoisted(() => ({
  printOrchestrationResultMock: vi.fn()
}))
vi.mock('../../output/command-result-output', () => ({ printResult: vi.fn() }))
vi.mock('../agent-view', () => ({ printOrchestrationResult: printOrchestrationResultMock }))
vi.mock('../../terminals/terminal-selector', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from '../orchestration-handlers'

// These tests cover the CLI side only: key and payload forwarding, the timeout-retry marker,
// and output. Server replay and refusal are exercised by the dispatcher test for the receipt.

type SendOptions =
  | { orchestrationRequestId?: string; orchestrationRetryAfterTimeout?: true }
  | undefined
type SentAttempt = { params: unknown; requestId: string; retryAfterTimeout: boolean }
type Step = (attempt: SentAttempt) => unknown

/** A local runtime's completed worker_done receipt, as the executor returns it on replay. */
function completedReceipt(requestId: string, replayed: boolean) {
  return {
    message: { id: 'msg_original', run_id: 'run_1', from_handle: 'term_worker' },
    lifecycle: { action: 'completed' },
    mutation: { requestId, replayed }
  }
}

function scriptedRuntime(steps: Step[]) {
  const attempts: SentAttempt[] = []
  const call = vi.fn(async (method: string, params: unknown, options?: SendOptions) => {
    if (method !== 'orchestration.send') {
      throw new Error(`unexpected ${method}`)
    }
    // RuntimeClient.call mints a fresh durable id per call when the caller supplies none.
    const attempt = {
      params,
      requestId: options?.orchestrationRequestId ?? randomUUID(),
      retryAfterTimeout: options?.orchestrationRetryAfterTimeout === true
    }
    attempts.push(attempt)
    const step = steps.shift()
    if (!step) {
      throw new Error('no scripted response left')
    }
    return { result: step(attempt) }
  })
  return { call, attempts }
}

// Shapes match RuntimeClient.call after attachMutationRecovery.
function sentTimeout({ requestId }: SentAttempt): never {
  throw new RuntimeClientError(
    'runtime_timeout',
    `Timed out waiting for the Orca runtime to respond. Orchestration mutation request ID: ${requestId}.`,
    {
      orchestrationRequestId: requestId,
      originalCommand: ['orca', 'orchestration', 'send', '--type', 'worker_done']
    }
  )
}

function unsentPreflightTimeout({ requestId }: SentAttempt): never {
  throw new RuntimeClientError(
    'runtime_timeout',
    `Timed out waiting for the Orca runtime to respond. Orchestration mutation request ID: ${requestId}.`,
    { orchestrationRequestId: requestId, requestSent: false }
  )
}

function receiptAbsentRefusal({ requestId }: SentAttempt): never {
  throw new RuntimeClientError(
    'retry_receipt_absent',
    `Mutation request ${requestId} has no receipt to replay; it may already have taken effect, so it was not run again. Orchestration mutation request ID: ${requestId}.`,
    { requestId, orchestrationRequestId: requestId }
  )
}

function send(call: ReturnType<typeof scriptedRuntime>['call'], type = 'worker_done') {
  const target: [string, string][] =
    type === 'worker_done'
      ? [
          ['task-id', 'task_1'],
          ['dispatch-id', 'ctx_1'],
          ['outcome', 'succeeded']
        ]
      : [['to', 'term_coordinator']]
  const flags = new Map<string, string | boolean>([
    ['from', 'term_worker'],
    ['subject', 'done'],
    ['type', type],
    ...target
  ])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the send handler only calls client.call, which the scripted runtime implements.
  const client = { call } as unknown as RuntimeClient
  return ORCHESTRATION_HANDLERS['orchestration send']({
    flags,
    client,
    cwd: '/tmp/repo',
    json: true
  })
}

const RESOLVED = Symbol('resolved')

/** Capture the outcome before timers advance so an early rejection is never unhandled. */
async function settleAfter(sent: Promise<void>, advanceMs: number): Promise<unknown> {
  const outcome = sent.then(
    () => RESOLVED,
    (error: unknown) => error
  )
  await vi.advanceTimersByTimeAsync(advanceMs)
  return await outcome
}

async function expectSettles(sent: Promise<void>, advanceMs: number) {
  expect(await settleAfter(sent, advanceMs)).toBe(RESOLVED)
}

async function expectTimeoutGuidance(sent: Promise<void>, advanceMs: number) {
  expect(await settleAfter(sent, advanceMs)).toMatchObject({
    code: 'runtime_timeout',
    message: expect.stringContaining('may already have taken effect'),
    data: { recovery: { disposition: 'outcome_unknown' } }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('retries a possibly delivered worker_done timeout under the same key and payload', async () => {
  const runtime = scriptedRuntime([
    sentTimeout,
    ({ requestId }) => completedReceipt(requestId, true)
  ])

  await expectSettles(send(runtime.call), 1_000)

  const [first, retry] = runtime.attempts
  expect(runtime.attempts).toHaveLength(2)
  expect(retry.requestId).toBe(first.requestId)
  expect(retry.params).toEqual(first.params)
  expect(first.retryAfterTimeout).toBe(false)
  expect(retry.retryAfterTimeout).toBe(true)
  expect(printOrchestrationResultMock).toHaveBeenCalledTimes(1)
  expect(printOrchestrationResultMock.mock.calls[0][0].result).toEqual(
    completedReceipt(first.requestId, true)
  )
})

it('retries a preflight timeout that never sent without the timeout-retry marker', async () => {
  const runtime = scriptedRuntime([
    unsentPreflightTimeout,
    ({ requestId }) => completedReceipt(requestId, false)
  ])

  await expectSettles(send(runtime.call), 1_000)

  const [first, retry] = runtime.attempts
  expect(runtime.attempts).toHaveLength(2)
  expect(retry.requestId).toBe(first.requestId)
  expect(retry.retryAfterTimeout).toBe(false)
  expect(printOrchestrationResultMock).toHaveBeenCalledTimes(1)
})

it('reports the original timeout guidance when the runtime has no receipt for the retry', async () => {
  const runtime = scriptedRuntime([sentTimeout, receiptAbsentRefusal])

  await expectTimeoutGuidance(send(runtime.call), 1_000)

  const [first, retry] = runtime.attempts
  expect(runtime.attempts).toHaveLength(2)
  expect(retry.requestId).toBe(first.requestId)
  expect(retry.retryAfterTimeout).toBe(true)
  expect(printOrchestrationResultMock).not.toHaveBeenCalled()
})

it('surfaces the inspect/retry guidance once timeouts exhaust the worker_done budget', async () => {
  const runtime = scriptedRuntime(Array.from({ length: 100 }, () => sentTimeout))

  const sent = send(runtime.call)
  await expectTimeoutGuidance(sent, 130_000)

  const [{ requestId }] = runtime.attempts
  expect(runtime.attempts.length).toBeGreaterThan(1)
  expect(runtime.attempts.every((attempt) => attempt.requestId === requestId)).toBe(true)
  await expect(sent).rejects.toMatchObject({
    message: expect.stringContaining(`--retry-request ${requestId}`),
    data: { orchestrationRequestId: requestId }
  })
})

it('does not retry a timed-out ordinary send', async () => {
  const runtime = scriptedRuntime([sentTimeout])

  await expectTimeoutGuidance(send(runtime.call, 'status'), 0)

  expect(runtime.attempts).toHaveLength(1)
})

it('does not retry a timed-out ordinary send after the wall clock steps backward', async () => {
  const runtime = scriptedRuntime([
    (attempt) => {
      // A clock correction while the request is outstanding must not open a retry window.
      vi.setSystemTime(Date.now() - 5 * 60_000)
      return sentTimeout(attempt)
    },
    ({ requestId }) => completedReceipt(requestId, false)
  ])

  await expectTimeoutGuidance(send(runtime.call, 'status'), 1_000)

  expect(runtime.attempts).toHaveLength(1)
})
