import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimeClientError } from '../../runtime/connection/types'
import { attachMutationRecovery } from '../../runtime/connection/client-error-recovery'
import type { RuntimeClient } from '../../runtime/client'
import { ORCHESTRATION_REPLAY_ONLY_RETRY_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRequestSelection } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

const { printOrchestrationResultMock } = vi.hoisted(() => ({
  printOrchestrationResultMock: vi.fn()
}))
vi.mock('../../output/command-result-output', () => ({ printResult: vi.fn() }))
vi.mock('../agent-view', () => ({ printOrchestrationResult: printOrchestrationResultMock }))
vi.mock('../../terminals/terminal-selector', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from '../orchestration-handlers'

// These tests cover the CLI side only: key and payload forwarding, when a retry is replay-only,
// which error is reported, and output. Server replay and refusal are in the dispatcher test.

type SendOptions =
  | {
      orchestrationRequestId?: string
      orchestrationReplayOnly?: true
      requestSelection?: RuntimeRequestSelection
    }
  | undefined
type SentAttempt = { params: unknown; requestId: string; replayOnly: boolean }
type Step = (attempt: SentAttempt) => unknown

/** The command line a worker ran, as RuntimeClient records it for recovery. */
const ORIGINAL_ARGV = [
  '/usr/local/bin/orca',
  'orchestration',
  'send',
  '--from',
  'term_worker',
  '--subject',
  'done',
  '--type',
  'worker_done',
  '--task-id',
  'task_1',
  '--dispatch-id',
  'ctx_1',
  '--outcome',
  'succeeded'
]

/** A local runtime's completed worker_done receipt, as the executor returns it on replay. */
function completedReceipt(requestId: string, replayed: boolean) {
  return {
    message: { id: 'msg_original', run_id: 'run_1', from_handle: 'term_worker' },
    lifecycle: { action: 'completed' },
    mutation: { requestId, replayed }
  }
}

const REPLAY_CAPABLE_STATUS = { capabilities: [ORCHESTRATION_REPLAY_ONLY_RETRY_RUNTIME_CAPABILITY] }

/** `recipientStatus` is what the runtime answers to a status pre-request on the same connection. */
function scriptedRuntime(steps: Step[], recipientStatus: unknown = REPLAY_CAPABLE_STATUS) {
  const attempts: SentAttempt[] = []
  const unsentReplays: string[] = []
  const call = vi.fn(async (method: string, params: unknown, options?: SendOptions) => {
    if (method !== 'orchestration.send') {
      throw new Error(`unexpected ${method}`)
    }
    // A status pre-request that refuses stops the transport before the request is written.
    const selected = options?.requestSelection
      ? (() => {
          try {
            return options.requestSelection.paramsForStatus(recipientStatus)
          } catch (error) {
            unsentReplays.push(options.orchestrationRequestId ?? '')
            throw error
          }
        })()
      : params
    // RuntimeClient.call mints a fresh durable id per call when the caller supplies none.
    const attempt = {
      params: selected,
      requestId: options?.orchestrationRequestId ?? randomUUID(),
      replayOnly: options?.orchestrationReplayOnly === true
    }
    attempts.push(attempt)
    const step = steps.shift()
    if (!step) {
      throw new Error('no scripted response left')
    }
    return { result: step(attempt) }
  })
  return { call, attempts, unsentReplays }
}

/** What RuntimeClient.call throws: the raw error with its request id and command attached. */
function keyed(error: RuntimeClientError, requestId: string, unsent = false): never {
  throw attachMutationRecovery(error, requestId, ORIGINAL_ARGV, unsent)
}

function sentTimeout({ requestId }: SentAttempt): never {
  keyed(
    new RuntimeClientError('runtime_timeout', 'Timed out waiting for the Orca runtime to respond.'),
    requestId
  )
}

function sentUnavailable({ requestId }: SentAttempt): never {
  keyed(
    new RuntimeClientError('runtime_unavailable', 'Orca closed the connection before responding.'),
    requestId
  )
}

function unsentUnavailable({ requestId }: SentAttempt): never {
  keyed(
    new RuntimeClientError('runtime_unavailable', 'This terminal could not connect to Orca.'),
    requestId,
    true
  )
}

function unsentPreflightTimeout({ requestId }: SentAttempt): never {
  keyed(
    new RuntimeClientError('runtime_timeout', 'Timed out waiting for the Orca runtime to respond.'),
    requestId,
    true
  )
}

// The runtime's refusal of a replay-only retry it cannot replay; it applied nothing.
function notReplayable({ requestId }: SentAttempt): never {
  keyed(
    new RuntimeClientError(
      'retry_not_replayable',
      `Mutation request ${requestId} has no receipt to replay; it may already have taken effect, so it was not run again.`,
      { requestId, reason: 'receipt_absent', effectsApplied: false }
    ),
    requestId
  )
}

// A runtime older than the replay-only contract refuses it as it refuses any unknown contract.
function olderRuntimeRefusal({ requestId }: SentAttempt): never {
  keyed(
    new RuntimeClientError(
      'orchestration_migration_required',
      'This orchestration mutation uses an obsolete contract. No effects were applied.',
      { reason: 'client_contract_unsupported', requiredContractVersion: 1 }
    ),
    requestId
  )
}

function accessDenied({ requestId }: SentAttempt): never {
  keyed(
    new RuntimeClientError(
      'runtime_access_denied',
      'This command is not allowed to reach the Orca runtime (EACCES).',
      { systemCode: 'EACCES' }
    ),
    requestId
  )
}

function callerNotLive({ requestId }: SentAttempt): never {
  keyed(
    new RuntimeClientError(
      'session_caller_not_live',
      'Agent session orca_session_id:worker is changing owners on this host. Retry when that finishes. No effects were applied.'
    ),
    requestId
  )
}

function send(
  call: ReturnType<typeof scriptedRuntime>['call'],
  type = 'worker_done',
  extraFlags: [string, string][] = []
) {
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
    ...target,
    ...extraFlags
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

/** Observe the command and advance the clock together, so an early rejection is never unhandled. */
async function settleAfter(sent: Promise<void>, advanceMs: number): Promise<unknown> {
  const [outcome] = await Promise.all([
    sent.then(
      () => RESOLVED,
      (error: unknown) => error
    ),
    vi.advanceTimersByTimeAsync(advanceMs)
  ])
  return outcome
}

async function expectSettles(sent: Promise<void>, advanceMs: number) {
  expect(await settleAfter(sent, advanceMs)).toBe(RESOLVED)
}

/** The original possibly delivered timeout, with same-key inspect and retry guidance. */
async function expectTimeoutGuidance(
  sent: Promise<void>,
  advanceMs: number,
  attempts: SentAttempt[]
) {
  const error = await settleAfter(sent, advanceMs)
  const requestId = attempts[0]?.requestId
  expect(error).toBeInstanceOf(RuntimeClientError)
  expect(error).toMatchObject({
    code: 'runtime_timeout',
    message: expect.stringContaining('may already have taken effect'),
    data: {
      orchestrationRequestId: requestId,
      originalCommand: ORIGINAL_ARGV,
      recovery: {
        disposition: 'outcome_unknown',
        queryCommand: [
          '/usr/local/bin/orca',
          'orchestration',
          'request-show',
          '--request',
          requestId,
          '--json'
        ],
        retryCommand: [...ORIGINAL_ARGV, '--retry-request', requestId]
      }
    }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('retries a possibly delivered worker_done timeout as a replay of the same key and payload', async () => {
  const runtime = scriptedRuntime([
    sentTimeout,
    ({ requestId }) => completedReceipt(requestId, true)
  ])

  await expectSettles(send(runtime.call), 1_000)

  const [first, retry] = runtime.attempts
  expect(runtime.attempts).toHaveLength(2)
  expect(retry.requestId).toBe(first.requestId)
  expect(retry.params).toEqual(first.params)
  expect(first.replayOnly).toBe(false)
  expect(retry.replayOnly).toBe(true)
  expect(printOrchestrationResultMock).toHaveBeenCalledTimes(1)
  expect(printOrchestrationResultMock.mock.calls[0][0].result).toEqual(
    completedReceipt(first.requestId, true)
  )
})

it('retries a preflight timeout that never sent as ordinary work', async () => {
  const runtime = scriptedRuntime([
    unsentPreflightTimeout,
    ({ requestId }) => completedReceipt(requestId, false)
  ])

  await expectSettles(send(runtime.call), 1_000)

  const [first, retry] = runtime.attempts
  expect(runtime.attempts).toHaveLength(2)
  expect(retry.requestId).toBe(first.requestId)
  expect(retry.replayOnly).toBe(false)
  expect(printOrchestrationResultMock).toHaveBeenCalledTimes(1)
})

it('keeps the existing unavailable retry as ordinary work', async () => {
  const runtime = scriptedRuntime([
    sentUnavailable,
    ({ requestId }) => completedReceipt(requestId, false)
  ])

  await expectSettles(send(runtime.call), 1_000)

  expect(runtime.attempts.map((attempt) => attempt.replayOnly)).toEqual([false, false])
})

it.each([
  ['the runtime has nothing to replay', notReplayable],
  ['an older runtime refuses the replay-only contract', olderRuntimeRefusal],
  ['the retry is denied access to the runtime', accessDenied],
  ['the caller is refused on the retry', callerNotLive]
])('reports the original timeout when %s', async (_case, refusal) => {
  const runtime = scriptedRuntime([sentTimeout, refusal])

  await expectTimeoutGuidance(send(runtime.call), 30_000, runtime.attempts)

  const [first, retry] = runtime.attempts
  // The refusal ends the retries: no third send.
  expect(runtime.attempts).toHaveLength(2)
  expect(retry.requestId).toBe(first.requestId)
  expect(retry.params).toEqual(first.params)
  expect(retry.replayOnly).toBe(true)
  expect(printOrchestrationResultMock).not.toHaveBeenCalled()
})

it('makes exactly one replay, and reports the original timeout when that replay fails', async () => {
  const runtime = scriptedRuntime([
    sentTimeout,
    sentUnavailable,
    ({ requestId }) => completedReceipt(requestId, true)
  ])

  await expectTimeoutGuidance(send(runtime.call), 30_000, runtime.attempts)

  expect(runtime.attempts.map((attempt) => attempt.replayOnly)).toEqual([false, true])
})

it('does not send the replay to a runtime that cannot prove it enforces replay-only', async () => {
  // A release without the contract fence would run the replay as a new send.
  const runtime = scriptedRuntime(
    [sentTimeout, ({ requestId }) => completedReceipt(requestId, false)],
    { capabilities: ['orchestration.contract.v1'] }
  )

  await expectTimeoutGuidance(send(runtime.call), 30_000, runtime.attempts)

  expect(runtime.attempts).toHaveLength(1)
  expect(runtime.unsentReplays).toEqual([runtime.attempts[0].requestId])
})

it('does not start a retry once the budget has passed, even if the timer fired late', async () => {
  // performance.now: the deadline base, the check before the backoff, then a late wake-up.
  const now = vi.spyOn(performance, 'now')
  now.mockReturnValueOnce(0).mockReturnValueOnce(118_000).mockReturnValueOnce(121_000)
  const runtime = scriptedRuntime([
    sentUnavailable,
    ({ requestId }) => completedReceipt(requestId, false)
  ])

  const error = await settleAfter(send(runtime.call), 1_000)

  expect(error).toMatchObject({ code: 'runtime_unavailable' })
  expect(runtime.attempts).toHaveLength(1)
  now.mockRestore()
})

it('surfaces the inspect/retry guidance when the one replay also times out', async () => {
  const runtime = scriptedRuntime(Array.from({ length: 100 }, () => sentTimeout))

  await expectTimeoutGuidance(send(runtime.call), 130_000, runtime.attempts)

  const [{ requestId }] = runtime.attempts
  expect(runtime.attempts).toHaveLength(2)
  expect(runtime.attempts.every((attempt) => attempt.requestId === requestId)).toBe(true)
})

it('does not retry a timed-out ordinary send', async () => {
  const runtime = scriptedRuntime([sentTimeout])

  await expectTimeoutGuidance(send(runtime.call, 'status'), 0, runtime.attempts)

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

  await expectTimeoutGuidance(send(runtime.call, 'status'), 1_000, runtime.attempts)

  expect(runtime.attempts).toHaveLength(1)
})

it('keeps the worker_done budget when the wall clock jumps forward', async () => {
  const runtime = scriptedRuntime([
    (attempt) => {
      // The budget runs on a monotonic clock; a wall-clock step must not end it early.
      vi.setSystemTime(Date.now() + 10 * 60_000)
      return sentUnavailable(attempt)
    },
    ({ requestId }) => completedReceipt(requestId, false)
  ])

  await expectSettles(send(runtime.call), 1_000)

  expect(runtime.attempts).toHaveLength(2)
})

it('replays only, once, when a timeout follows an attempt that may have been delivered', async () => {
  // A quick close after the write may have committed; the later timeout never sent anything.
  const runtime = scriptedRuntime([
    sentUnavailable,
    unsentPreflightTimeout,
    ({ requestId }) => completedReceipt(requestId, true)
  ])

  await expectSettles(send(runtime.call), 30_000)

  expect(runtime.attempts.map((attempt) => attempt.replayOnly)).toEqual([false, false, true])
})

it('keeps the earlier possible delivery as the outcome when that replay is refused', async () => {
  const runtime = scriptedRuntime([sentUnavailable, unsentPreflightTimeout, notReplayable])

  const error = await settleAfter(send(runtime.call), 30_000)

  expect(runtime.attempts).toHaveLength(3)
  expect(error).toMatchObject({
    code: 'runtime_unavailable',
    data: { recovery: { disposition: 'outcome_unknown' } }
  })
})

it('retries as ordinary work when every earlier attempt is known not to have been sent', async () => {
  const runtime = scriptedRuntime([
    unsentUnavailable,
    unsentPreflightTimeout,
    ({ requestId }) => completedReceipt(requestId, false)
  ])

  await expectSettles(send(runtime.call), 30_000)

  expect(runtime.attempts.map((attempt) => attempt.replayOnly)).toEqual([false, false, false])
})

it('keeps a pairing code out of the guidance and withholds the default-target query', async () => {
  const runtime = scriptedRuntime([sentTimeout, notReplayable])

  const error = await settleAfter(
    send(runtime.call, 'worker_done', [['pairing-code', 'orca://pair?code=secret']]),
    30_000
  )

  expect(error).toMatchObject({ code: 'runtime_timeout' })
  expect(error).not.toHaveProperty('data.recovery.queryCommand')
  expect(String(error)).not.toContain('secret')
})
