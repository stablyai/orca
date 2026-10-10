// The retry's one wake and one budget: a commit after a lock refused a round runs the next one at
// once; reads during a backoff add no round and leave the budget alone; after a give-up only a
// newly owed chat or a commit starts a fresh episode.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
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

function openRetry(): StructuredAgentSessionRetry {
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
    sessions: new Map([[CHAT, { journal }]]),
    now: () => 0,
    serialize: (_id: string, task: () => Promise<unknown>) => task(),
    laneBusy: () => false,
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

/** Rounds refused by the lock until the episode gives up. */
async function exhaust(retry: StructuredAgentSessionRetry): Promise<void> {
  retry.signal(CHAT)
  await settleTurns()
  while (retry['failingFor'] < RECONCILIATION_GIVE_UP_MS || retry['timer'] !== null) {
    await vi.advanceTimersByTimeAsync(2_000)
    await settleTurns()
  }
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
  const waited = retry['failingFor']

  for (let read = 0; read < 20; read += 1) {
    retry.opened(CHAT, journal)
  }
  await settleTurns()

  expect(pass.mock.calls.length).toBeLessThanOrEqual(2)
  expect(retry['failingFor']).toBe(waited)
  retry.dispose()
})

it('before a give-up, a signal, a commit or a read leaves the budget counting', async () => {
  const retry = openRetry()
  retry.signal(CHAT)
  await settleTurns()
  await vi.advanceTimersByTimeAsync(3_000)
  await settleTurns()
  const waited = retry['failingFor']
  expect(waited).toBeGreaterThan(0)

  retry.signal(CHAT)
  retry.observeCommit('another-chat', null)
  retry.opened(CHAT, journal)
  await settleTurns()

  expect(retry['failingFor']).toBeGreaterThanOrEqual(waited)
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
  expect(retry['failingFor']).toBeLessThan(RECONCILIATION_GIVE_UP_MS)

  await exhaust(retry)
  const again = pass.mock.calls.length
  lockHeld = false
  retry.observeCommit('another-chat', null)
  await settleTurns()
  expect(pass).toHaveBeenCalledTimes(again + 1)
  expect(retryOwes(retry, CHAT)).toBe(false)
  retry.dispose()
})
