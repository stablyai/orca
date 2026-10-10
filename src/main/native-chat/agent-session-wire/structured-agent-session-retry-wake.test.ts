// The retry's one wake and one budget: a commit after a lock refused a round runs the next one at
// once; reads during a backoff add no round and leave the budget alone; after a give-up only a
// newly owed chat or a commit starts a fresh episode.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as reconciliationLoad from './structured-agent-session-reconciliation-load'
import * as reconciliationPass from './structured-agent-session-reconciliation-pass'
import { RECONCILIATION_GIVE_UP_MS } from './structured-agent-session-reconciliation-backoff'
import {
  StructuredAgentSessionRetry,
  type StructuredAgentSessionRetryContext
} from './structured-agent-session-reconciliation-retry'
import { retryOwes } from './structured-agent-session-retry.test-fixture'

const CHAT = 'chat-1'
const journal = { openedAt: () => ({ epoch: 'e', sequence: 0 }) }
const locked = () => Object.assign(new Error('database is locked'), { errcode: 5 })

let lockHeld = true
let pass: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  lockHeld = true
  pass = vi
    .spyOn(reconciliationPass, 'runStructuredAgentSessionReconciliationPass')
    .mockImplementation(async () => ({
      failed: lockHeld ? [locked()] : [],
      wrote: false,
      recovering: false
    }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function settleTurns(): Promise<void> {
  for (let turn = 0; turn < 30; turn++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** `busy`: whether a person's operation holds the chat's lane. `closed`: no reader has it open. */
function openRetry(
  options: { busy?: () => boolean; closed?: true } = {}
): StructuredAgentSessionRetry {
  const context = {
    deps: {
      store: {
        onGenerationEnded: () => () => undefined,
        getRecord: () => ({ lease: { unreconciled: false, runtimeFence: 1 } }),
        listRecords: () => [],
        readOnly: false
      },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
    },
    sessions: new Map(options.closed ? [] : [[CHAT, { journal }]]),
    now: () => 0,
    serialize: (_id: string, task: () => Promise<unknown>) => task(),
    laneBusy: () => options.busy?.() ?? false,
    track: (operation: Promise<unknown>) => operation,
    publishGenerationEnded: vi.fn(),
    reconcileOwed: () => false,
    reconcile: async () => 'settled' as const,
    sendQueued: async () => 'done' as const,
    abandonSend: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retry reads only the fields above; the host's full deps would add nothing these tests exercise.
  const typed = context as unknown as StructuredAgentSessionRetryContext
  return new StructuredAgentSessionRetry(typed)
}

/** Rounds refused by the lock until the episode gives up: no timer is left. */
async function exhaust(retry: StructuredAgentSessionRetry): Promise<void> {
  retry.signal(CHAT)
  await settleTurns()
  for (let elapsed = 0; elapsed < RECONCILIATION_GIVE_UP_MS + 4_000; elapsed += 2_000) {
    await vi.advanceTimersByTimeAsync(2_000)
    await settleTurns()
  }
  expect(retry['timer']).toBeNull()
}

it('a commit after a lock refused a round runs the next one at once, with no timer', async () => {
  const retry = openRetry()
  retry.signal(CHAT)
  await settleTurns()
  expect(pass).toHaveBeenCalledTimes(1)

  lockHeld = false
  retry.observeCommit('another-chat', null)
  await settleTurns()
  expect(pass).toHaveBeenCalledTimes(2)
  expect(retryOwes(retry, CHAT)).toBe(false)
  retry.dispose()
})

it('reads during a backoff add no round and leave the budget as it is', async () => {
  const retry = openRetry()
  retry.signal(CHAT)
  await settleTurns()
  const waited = retry['failingFor']()

  for (let read = 0; read < 20; read += 1) {
    retry.opened(CHAT, journal)
  }
  await settleTurns()

  expect(pass.mock.calls.length).toBeLessThanOrEqual(2)
  expect(retry['failingFor']()).toBe(waited)
  retry.dispose()
})

it('before a give-up, a signal, a commit or a read leaves the budget counting', async () => {
  const retry = openRetry()
  retry.signal(CHAT)
  await settleTurns()
  await vi.advanceTimersByTimeAsync(3_000)
  await settleTurns()
  const waited = retry['failingFor']()
  expect(waited).toBeGreaterThan(0)

  retry.signal(CHAT)
  retry.observeCommit('another-chat', null)
  retry.opened(CHAT, journal)
  await settleTurns()

  expect(retry['failingFor']()).toBeGreaterThanOrEqual(waited)
  retry.dispose()
})

it('after a give-up only a newly owed chat or a commit starts a fresh episode', async () => {
  const retry = openRetry()
  await exhaust(retry)
  const given = pass.mock.calls.length
  // Nothing of its own: no timer, however long.
  await vi.advanceTimersByTimeAsync(600_000)
  await settleTurns()
  expect(pass).toHaveBeenCalledTimes(given)

  retry.signal(CHAT)
  await settleTurns()
  expect(pass).toHaveBeenCalledTimes(given + 1)
  expect(retry['failingFor']()).toBeLessThan(RECONCILIATION_GIVE_UP_MS)

  await exhaust(retry)
  const again = pass.mock.calls.length
  lockHeld = false
  retry.observeCommit('another-chat', null)
  await settleTurns()
  expect(pass).toHaveBeenCalledTimes(again + 1)
  expect(retryOwes(retry, CHAT)).toBe(false)
  retry.dispose()
})

it('keeps the budget through a round whose only chat waited on a busy lane', async () => {
  let busy = false
  const retry = openRetry({ busy: () => busy })
  retry.signal(CHAT)
  await settleTurns()
  await vi.advanceTimersByTimeAsync(500)
  expect(retry['failures']).toBe(1)

  // The lock lifts, but a person's operation holds the lane: no progress, so no reset.
  lockHeld = false
  busy = true
  retry.observeCommit('another-chat', null)
  await settleTurns()

  expect(pass).toHaveBeenCalledTimes(1)
  expect(retry['failures']).toBe(1)
  retry.dispose()
})

it('drops a closed chat it loaded when its episode gives up, and keeps it owed', async () => {
  const close = vi.fn(async () => undefined)
  const loads = vi
    .spyOn(reconciliationLoad, 'loadStructuredAgentSessionForReconciliation')
    .mockResolvedValue({
      kind: 'loaded',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the visit reads only the journal's open cursor and close of a loaded read.
      session: { journal: { ...journal, close } } as never
    })
  vi.spyOn(reconciliationLoad, 'structuredAgentSessionJournalIsCurrent').mockReturnValue(true)
  const retry = openRetry({ closed: true })

  await exhaust(retry)

  expect(loads).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledOnce()
  expect(retry['owed'].get(CHAT)?.loaded).toBeUndefined()
  expect(retryOwes(retry, CHAT)).toBe(true)
  retry.dispose()
})

it('gives up after about 3 minutes of wall time, however often commits wake it early', async () => {
  const retry = openRetry()
  const warn = vi.mocked(retry['context'].deps.logger.warn)
  const gaveUp = () => warn.mock.calls.filter(([message]) => message.startsWith('gave up')).length
  retry.signal(CHAT)
  await settleTurns()
  // A commit every 100 ms: each ends the backoff and runs a refused round at once.
  for (let elapsed = 0; elapsed < 170_000; elapsed += 100) {
    retry.observeCommit('another-chat', null)
    await settleTurns()
    await vi.advanceTimersByTimeAsync(100)
  }
  expect(gaveUp()).toBe(0)

  for (let elapsed = 0; elapsed < 12_000; elapsed += 100) {
    retry.observeCommit('another-chat', null)
    await settleTurns()
    await vi.advanceTimersByTimeAsync(100)
  }
  expect(gaveUp()).toBe(1)
  retry.dispose()
})
